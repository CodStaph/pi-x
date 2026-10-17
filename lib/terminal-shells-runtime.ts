import { spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";
import {
  isTerminalShellId,
  wslCdArgs,
  type TerminalShellId,
  type TerminalShellKind,
  type TerminalShellProfile,
} from "./terminal-shells";

export interface TerminalShellCandidate {
  id: TerminalShellId;
  kind: TerminalShellKind;
  available: boolean;
  executable?: string;
  args: string[];
}

type ResolvedShell = TerminalShellCandidate;

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of raw.split(path.delimiter)) {
    const trimmed = directory.replace(/^"|"$/g, "");
    if (!trimmed) continue;
    for (const extension of extensions) {
      const candidate = path.join(trimmed, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Walk up from a Git executable until the install root (the one containing
 *  `cmd\git.exe` or `bin\git.exe`) is found. Handles `cmd\`, `mingw64\bin\`
 *  and `usr\bin\` layouts, which sit at different depths. */
function gitRootFor(executablePath: string): string | null {
  let directory = path.dirname(executablePath);
  for (let depth = 0; depth < 5; depth++) {
    if (isFile(path.join(directory, "cmd", "git.exe")) || isFile(path.join(directory, "bin", "git.exe"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Git for Windows ships bash at `<install>\bin\bash.exe`. The install can live
 * anywhere, so derive it from `git.exe` (which is on PATH whenever Git Bash is
 * usable) before falling back to the standard directories. A bare `bash.exe` on
 * PATH is only accepted when the surrounding tree proves it is Git's.
 */
function findGitBash(): string | null {
  const candidates: string[] = [];
  const installRoot = process.env.GIT_INSTALL_ROOT;
  if (installRoot) {
    candidates.push(
      path.join(installRoot, "bin", "bash.exe"),
      path.join(installRoot, "usr", "bin", "bash.exe"),
    );
  }

  const git = findOnPath("git");
  if (git) {
    const root = gitRootFor(git);
    if (root) candidates.push(path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe"));
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  candidates.push(
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "bin", "bash.exe"),
  );
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  }

  const onPath = findOnPath("bash");
  if (onPath) {
    const root = gitRootFor(onPath);
    if (root) candidates.push(path.join(root, "bin", "bash.exe"), onPath);
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function findWsl(): string | null {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const system = path.join(systemRoot, "System32", "wsl.exe");
  return isFile(system) ? system : findOnPath("wsl");
}

const WSL_PROBE_TIMEOUT_MS = 3_000;
let wslDistroProbe: boolean | undefined;

/**
 * Whether `wsl --list --quiet` reported at least one installed distro.
 *
 * `wsl.exe` ships with Windows (and the Store "wsl" stub) even when no distro
 * is installed; it then prints to stderr and exits non-zero, or prints only a
 * blank line. Without this check the `auto` strategy would pick a shell that
 * cannot start. Older `wsl.exe` prints UTF-16LE, so NUL bytes are stripped
 * before the empty check.
 */
export function parseWslDistroList(stdout: string, status: number | null): boolean {
  if (status !== 0) return false;
  return stdout.replace(/\0/g, "").split(/\r?\n/).some((line) => line.trim().length > 0);
}

/** Cached for the process: the probe spawns a process and can take seconds. */
function wslHasDistro(executable: string): boolean {
  if (wslDistroProbe !== undefined) return wslDistroProbe;
  try {
    const result = spawnSync(executable, ["--list", "--quiet"], {
      encoding: "utf8",
      timeout: WSL_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    wslDistroProbe = parseWslDistroList(result.stdout ?? "", result.status);
  } catch {
    wslDistroProbe = false;
  }
  return wslDistroProbe;
}

/**
 * Windows profiles in picker order. `probeWsl` is false for callers that cannot
 * select WSL anyway, so an explicit `cmd` request never waits on the probe.
 */
function windowsShells(probeWsl: boolean): ResolvedShell[] {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const comspec = process.env.ComSpec;
  const cmd = comspec && isFile(comspec) ? comspec : path.join(systemRoot, "System32", "cmd.exe");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const pwsh = findOnPath("pwsh");
  const gitBash = findGitBash();
  const wsl = findWsl();
  return [
    { id: "cmd", kind: "windows", available: isFile(cmd), executable: cmd, args: [] },
    { id: "powershell", kind: "windows", available: isFile(powershell), executable: powershell, args: ["-NoLogo"] },
    { id: "pwsh", kind: "windows", available: Boolean(pwsh), executable: pwsh ?? undefined, args: ["-NoLogo"] },
    { id: "git-bash", kind: "linux", available: Boolean(gitBash), executable: gitBash ?? undefined, args: ["-l"] },
    {
      id: "wsl",
      kind: "linux",
      // A bare wsl.exe is not a usable shell: require an installed distro.
      available: Boolean(wsl) && (!probeWsl || wslHasDistro(wsl as string)),
      executable: wsl ?? undefined,
      args: [],
    },
  ];
}

/**
 * The shell `auto` selects: WSL when a distro answered the probe, then Git
 * Bash, then cmd. Never an unavailable entry; `undefined` when none is usable.
 */
export function chooseAutoShell(
  shells: readonly TerminalShellCandidate[],
): TerminalShellCandidate | undefined {
  const usable = (id: TerminalShellId) => shells.find((shell) => shell.id === id && shell.available);
  return usable("wsl") ?? usable("git-bash") ?? usable("cmd") ?? shells.find((shell) => shell.available);
}

/** Shell profiles to offer in the picker, with unavailable ones marked. */
export function listTerminalShells(platform: NodeJS.Platform = process.platform): TerminalShellProfile[] {
  if (platform !== "win32") {
    return [{ id: "system", kind: "system", available: true }];
  }
  const shells = windowsShells(true);
  return [
    { id: "auto", kind: "linux", available: true },
    ...shells.map(({ id, kind, available }) => ({ id, kind, available })),
  ];
}

export interface TerminalSpawnSpec {
  executable: string;
  args: string[];
}

/**
 * Resolve a stored/requested id into an executable + argv. `auto` picks the
 * most Linux-like shell available on Windows (WSL with a distro, then Git Bash,
 * then cmd); on POSIX every id falls through to the user's login shell.
 */
export function resolveTerminalShell(
  requested: string | undefined,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): TerminalSpawnSpec {
  if (platform !== "win32") {
    return { executable: process.env.SHELL || "/bin/sh", args: ["-l"] };
  }

  const desired = isTerminalShellId(requested) ? requested : "auto";
  const shells = windowsShells(desired === "auto" || desired === "wsl");
  const byId = (target: TerminalShellId) => shells.find((shell) => shell.id === target);

  let chosen: ResolvedShell | undefined;
  if (desired === "auto") {
    chosen = chooseAutoShell(shells);
  } else if (desired === "system") {
    chosen = byId("cmd");
  } else {
    chosen = byId(desired);
  }
  // An id this platform does not offer, or one that is unavailable, falls back
  // to cmd rather than failing the tab.
  if (!chosen?.available || !chosen.executable) chosen = byId("cmd");

  const executable = chosen?.executable ?? (process.env.ComSpec || "cmd.exe");
  const args = chosen?.id === "wsl" ? [...(chosen.args ?? []), ...wslCdArgs(cwd)] : [...(chosen?.args ?? [])];
  return { executable, args };
}
