export const TERMINAL_SHELL_IDS = [
  "auto",
  "system",
  "cmd",
  "powershell",
  "pwsh",
  "git-bash",
  "wsl",
] as const;

export type TerminalShellId = (typeof TERMINAL_SHELL_IDS)[number];
export type TerminalShellKind = "system" | "windows" | "linux";

export interface TerminalShellProfile {
  id: TerminalShellId;
  kind: TerminalShellKind;
  available: boolean;
}

export function isTerminalShellId(value: unknown): value is TerminalShellId {
  return typeof value === "string" && (TERMINAL_SHELL_IDS as readonly string[]).includes(value);
}

/**
 * Translate a drive-letter Windows path into its WSL mount (`D:\a\b` →
 * `/mnt/d/a/b`). UNC and relative paths cannot be mapped and return null, in
 * which case the WSL shell simply starts in its own home directory.
 */
export function toWslPath(winPath: string): string | null {
  const match = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(winPath.trim());
  if (!match) return null;
  const rest = (match[2] ?? "").split(/[\\/]+/).filter(Boolean).join("/");
  return rest ? `/mnt/${match[1].toLowerCase()}/${rest}` : `/mnt/${match[1].toLowerCase()}`;
}

/** `wsl.exe --cd <mount>` arguments for a Windows cwd, or `[]` when unmappable. */
export function wslCdArgs(winCwd: string): string[] {
  const wslCwd = toWslPath(winCwd);
  return wslCwd ? ["--cd", wslCwd] : [];
}
