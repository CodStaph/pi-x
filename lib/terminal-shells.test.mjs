import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isTerminalShellId,
  toWslPath,
  wslCdArgs,
} = await jiti.import("./terminal-shells");
const {
  chooseAutoShell,
  listTerminalShells,
  parseWslDistroList,
  resolveTerminalShell,
} = await jiti.import("./terminal-shells-runtime");

test("maps drive-letter paths to WSL mounts", () => {
  assert.equal(toWslPath("D:\\work\\repo"), "/mnt/d/work/repo");
  assert.equal(toWslPath("C:/Users/me/project"), "/mnt/c/Users/me/project");
  assert.equal(toWslPath("D:\\"), "/mnt/d");
  assert.equal(toWslPath("D:"), "/mnt/d");
  assert.equal(toWslPath("D:\\a\\\\b\\"), "/mnt/d/a/b");
});

test("refuses paths WSL cannot mount", () => {
  assert.equal(toWslPath("\\\\server\\share\\dir"), null);
  assert.equal(toWslPath("/usr/bin"), null);
  assert.equal(toWslPath("relative\\path"), null);
  assert.equal(toWslPath(""), null);
});

test("builds --cd arguments only for mappable paths", () => {
  assert.deepEqual(wslCdArgs("D:\\work"), ["--cd", "/mnt/d/work"]);
  assert.deepEqual(wslCdArgs("\\\\server\\share"), []);
});

test("validates shell ids", () => {
  for (const id of ["auto", "system", "cmd", "powershell", "pwsh", "git-bash", "wsl"]) {
    assert.equal(isTerminalShellId(id), true, id);
  }
  for (const value of ["", "bash", "GIT-BASH", null, 3, undefined]) {
    assert.equal(isTerminalShellId(value), false, String(value));
  }
});

test("offers only the system shell on POSIX", () => {
  assert.deepEqual(listTerminalShells("linux"), [{ id: "system", kind: "system", available: true }]);
});

test("always lists the Windows profiles, with availability resolved", () => {
  const shells = listTerminalShells("win32");
  assert.deepEqual(shells.map((shell) => shell.id), ["auto", "cmd", "powershell", "pwsh", "git-bash", "wsl"]);
  for (const shell of shells) {
    assert.equal(typeof shell.available, "boolean");
  }
  // `auto` is a strategy, never a missing binary.
  assert.equal(shells.find((shell) => shell.id === "auto").available, true);
});

test("POSIX resolution ignores the requested id and uses the login shell", () => {
  const spec = resolveTerminalShell("wsl", "/tmp", "linux");
  assert.equal(spec.executable, process.env.SHELL || "/bin/sh");
  assert.deepEqual(spec.args, ["-l"]);
});

test("Windows resolution always returns an executable and argv", () => {
  const spec = resolveTerminalShell("auto", "D:\\work", "win32");
  assert.equal(typeof spec.executable, "string");
  assert.ok(spec.executable.length > 0);
  assert.ok(Array.isArray(spec.args));
});

test("reads the WSL distro list, including a UTF-16 reply and failures", () => {
  assert.equal(parseWslDistroList("Ubuntu\n", 0), true);
  // Old wsl.exe prints UTF-16LE, which arrives NUL-separated.
  assert.equal(parseWslDistroList("U\0b\0u\0n\0t\0u\0\r\0\n\0", 0), true);
  assert.equal(parseWslDistroList("", 0), false);
  assert.equal(parseWslDistroList("  \r\n\n", 0), false);
  // No distro installed: wsl.exe exits non-zero (or the probe timed out).
  assert.equal(parseWslDistroList("Ubuntu\n", 1), false);
  assert.equal(parseWslDistroList("", null), false);
});

test("auto prefers WSL only with a distro, then Git Bash, then cmd", () => {
  const shell = (id, available) => ({
    id,
    kind: id === "cmd" ? "windows" : "linux",
    available,
    executable: available ? `${id}.exe` : undefined,
    args: [],
  });

  assert.equal(chooseAutoShell([shell("cmd", true), shell("git-bash", true), shell("wsl", true)]).id, "wsl");
  assert.equal(chooseAutoShell([shell("cmd", true), shell("git-bash", true), shell("wsl", false)]).id, "git-bash");
  assert.equal(chooseAutoShell([shell("cmd", true), shell("git-bash", false), shell("wsl", false)]).id, "cmd");
  assert.equal(chooseAutoShell([shell("cmd", false), shell("git-bash", false), shell("wsl", false)]), undefined);
  // An unavailable WSL must never win, even at the head of the list.
  assert.notEqual(chooseAutoShell([shell("wsl", false), shell("git-bash", true)]).id, "wsl");
});
