# Workspace Terminals

The Explorer terminal action opens or focuses a terminal for its selected cwd
in the right panel's existing tab bar. Each terminal tab keeps the cwd it was
created with. Files still mount only their active viewer; terminal panels stay
mounted behind inactive tabs, hidden panels, and session or project switches.

## Lifecycle

- Each new tab generates a random terminal ID before creation. Creation with
  the same ID and cwd is idempotent, including React Strict Mode's repeated
  effects. An existing ID cannot be reused for another cwd.
- `sessionStorage` retains terminal IDs, cwds, and the active terminal layout
  across refresh. Restored tabs first check the existing server instance and
  never silently start replacement processes after expiry or server restart.
- A new PTY gets a 120-second connection lease. Subscribing cancels expiry;
  the last subscriber leaving starts a new 120-second grace period. This also
  collects creations that never establish their initial connection.
- Hiding a panel, switching tabs, and unmounting a component only disconnect
  clients. Explicitly terminating a tab waits for creation and in-flight input
  before deleting the PTY. Restart waits for termination before creating a new
  ID. Failed termination leaves the tab available to retry.
- A shell exit closes the SSE stream and retains its output and exit code in
  the browser. Unobserved server records expire after the same grace period.
- Explicit termination and expiry signal the shell, escalating to SIGKILL after
  two seconds if it ignores SIGHUP. Server shutdown force-kills shells immediately.

## Shell profiles

Each tab stores a shell profile id (`auto`, `cmd`, `powershell`, `pwsh`,
`git-bash`, `wsl`, or the POSIX `system`). The terminal panel header picks the
shell for that tab; changing it restarts the tab, and the star keeps it as the
default for new terminals (`pi-terminal-shell`, `lib/app-prefs.ts`).
`GET /api/terminal/shells` reports what this machine has; `POST /api/terminal`'s
`shell` field is resolved by `lib/terminal-shells-runtime.ts` into the pty spawn.

- `auto` is a strategy, not a binary: on Windows it resolves WSL first, then Git
  Bash, then cmd, so a machine with WSL installed gets a Linux shell without
  further configuration. POSIX always uses `$SHELL -l` regardless of the id.
- Git Bash is found by walking up from `git.exe`/`bash.exe` to its install root
  (the directory holding `cmd\git.exe` or `bin\git.exe`), which covers the
  `cmd\`, `mingw64\bin\` and `usr\bin\` layouts; the standard install folders
  are the fallback. A bare `bash.exe` on PATH is only accepted when that tree
  proves it belongs to Git (System32's retired WSL `bash.exe` must not win).
- WSL is launched as `wsl.exe --cd /mnt/<drive>/...` (`toWslPath()`), so the tab
  opens in the mapped directory; UNC or relative paths fall back to WSL's home.
- A restored tab whose shell is no longer available falls back to the first
  profile the machine reports, never a dead option.

## Transport

Output events carry a monotonically increasing UTF-16 offset in SSE `id`.
Reconnections use `Last-Event-ID` (or `after` on an explicit reconnect) and send
only the missing suffix. The server keeps at most 128 KiB of UTF-16 code units;
an older cursor triggers a terminal reset and bounded history replay. This is
bounded output history, not a serialized full-screen terminal snapshot. Slow
SSE consumers are disconnected once their response queue fills.

Input and resizes are serialized. Pending adjacent input is batched so remote
connections do not require one round trip per keystroke; large pastes are split
without splitting Unicode characters. Failed input is not retried because its
delivery may be ambiguous. Reconnect attaches to the same process with a fresh
writer; restart explicitly replaces the process.

`bin/prepare-terminal.js` repairs node-pty 1.1.0's macOS spawn-helper executable
bits during installation, including published/npm-installed Pi Web packages.

Pi Web pins node-pty to `1.2.0-beta.15`, which includes Linux x64 and ARM64
prebuilt binaries. Native module loading is deferred until terminal creation,
so missing or incompatible binaries produce a JSON error with repair instructions.
Empty or non-JSON API errors show the HTTP status and direct users to the server log.

If a native binary cannot load, run
`npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts` from the
installation directory (for npx, the cache directory containing `node_modules`).
On Debian/Ubuntu, install `python3` and `build-essential` first. This forces a
source build instead of reusing a missing or incompatible prebuilt binary.
Restart Pi Web after repair.

## Verification

Run `npm test` for native PTY, lease, output cursor, input queue, and storage
checks. `npm run test:terminal` starts an isolated development server and runs
desktop/mobile browser checks using generated session fixtures. Install the
Playwright Chromium browser first with `npx playwright install chromium`.
The browser check prints the temporary location of its screenshots and log.
