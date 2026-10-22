# 0008 — One pi-web process owns an agent directory

## Status

Accepted. This records the assumption the code already makes; it does not change
behaviour. It exists because a page-wide `globalThis` registry, SSE broadcasts and
the session idle timer are all correct only under this assumption, and nothing
said so out loud.

## Context

Three shapes run against the same `~/.pi/agent`:

1. **Desktop app** — the Tauri shell starts a bundled Node server
   (`desktop/server-launcher.cjs`) and passes it a port and a desktop API token.
2. **`npx pi-web` / `npm i -g @agegr/pi-web`** — the same server from the system
   Node, typically for LAN access or a second window.
3. **`pi` CLI and extensions** — a third writer, unaware of either server.

They share the agent directory, and only one of the three can be *the* owner of
in-process state. Today that state lives on `globalThis` (survives Next's hot
reload) in 26 places, including:

| State | Where |
|---|---|
| Session registry, start locks, starting-cwd counts, running listeners | `lib/session/registry.ts` |
| Session list cache + generation, path caches, `SessionManager` cache | `lib/session-reader.ts` |
| Scan index (persisted under `<agentDir>`) | `lib/session-list-scanner.ts` |
| Subagent runs / queue / consumed results | `lib/subagent-runtime.ts`, `lib/subagents.ts` |
| Model catalog cache, catalog-refresh passes, project cache | `lib/models-cache.ts`, `lib/project-identity.ts` |
| Allowed file roots | `lib/file-access.ts` |
| Auth throttling, login callbacks | `lib/auth-throttle.ts`, `app/api/auth/**` |
| Terminals | `app/api/terminal/**` |
| Web-push notifier, migration failure | `lib/web-push.ts`, `lib/migrations/index.ts` |

Nothing in that list is visible to another process. The running-set broadcast
(`notifyRunningChange()` → `/api/agent/running/events`) reaches only the windows
connected to *this* server, and the idle timer only evicts wrappers in *this*
process.

## Decision

**One pi-web server per agent directory is the supported deployment.** A second
one is not forbidden — it is simply not guaranteed: each keeps its own registry,
its own caches and its own view of what is running.

Four rules make that safe enough in practice.

### 1. In-process state is never the cross-process authority

The agent directory is. Anything another instance must see is read from a file, and
anything written for another instance goes through one of the mechanisms below.
A feature that would need "the other window's registry" is out of scope by
construction.

### 2. Writes to shared files fall into three classes

| Class | Mechanism | Files |
|---|---|---|
| **Locked read-modify-write** | `proper-lockfile` around the whole update | `settings.json`, `auth.json`, `mcp.json` (`lib/global-settings-file.ts`, `lib/provider-credential-store.ts`, `lib/mcp-config-file.ts`) |
| **Atomic replace, last writer wins** | write temp + rename, mode 0600 (`writePrivateFileAtomicSync`) | `models.json`, `agents/settings.json`, `desktop/*.json`, scheduled task files, the migration ledger |
| **Append only** | one line per record, never rewritten | `sessions/**/*.jsonl`, `scheduled-tasks/**/runs.jsonl` |

A file in the second class can lose a concurrent update from another process; it
will never be left half-written. Any new *read-modify-write* of a shared file must
use class 1, and `lib/global-settings-file.ts` is the reference for how (lock,
re-read inside the lock, compare, write, chmod).

### 3. One writer per session file

Two processes must not prompt the same session at once. `pi` itself never asks two
processes to share one session, and pi-web detects the *benign* case: when another
process appended to the file, an idle wrapper is dropped and rebuilt on the next
read (`evictIfDiskAhead()` in `lib/rpc-manager.ts`). Detection is not mutual
exclusion — a session running in this process is never evicted mid-run, which means
the second process can still write into it. That case stays undefined.

The session list has the same shape: each process keeps its own incremental scan
index and cache, so a rename in the other window appears here only after the next
list refetch, which is why `session_info_changed` bumps `sessionListVersion` and
every connected window refetches.

### 4. Exclusive background work takes a file lease

Scheduled tasks are the only work that must not run twice. `lib/scheduled-tasks/lease.ts`
holds `scheduler.lock` (pid + heartbeat, stale after 90 s), and `Scheduler` only
fires while it owns that lease. Browser tabs share one SSE stream through a
leadership election in `lib/scheduled-tasks/shared-stream.ts`, which is in-process
by design (tabs of one server).

## Consequences

- **Two servers, one agent dir**: fine for browsing the same sessions, editing
  settings, and running the desktop app beside a LAN server. Not supported:
  prompting the same session from both, expecting one running-set view, or
  expecting an in-process cache to be invalidated by the other process within a
  request.
- **Desktop + `npx pi-web`**: exactly one fires scheduled tasks (the lease holder);
  the other logs nothing and does nothing, by design.
- **`pi` CLI alongside**: the CLI is a fourth writer with its own rules (SDK locks
  for `auth.json`, its own session writes). pi-web treats its appends as "disk
  ahead" and rebuilds.
- The 26 `globalThis` blocks are a *hot-reload* device. They must never grow into
  a cross-process protocol; if a feature needs one, this ADR has to change first.

## Non-goals

- Multi-user or multi-tenant hosting; remote access is single-operator (see
  `proxy.ts`, `PI_WEB_PASSWORD`, and the LAN warning in `bin/network-exposure-warning.js`).
- Distributed agent scheduling, cross-process event buses, or shared in-memory
  sessions.
- Making two servers safely prompt one session. That would need per-session file
  locking around the whole run plus a shared idle/lease protocol — a design, not a
  patch.

## When to revisit

Any of these makes the assumption load-bearing in a way it is not today:

1. a feature that requires two servers to cooperate on one session;
2. remote/mobile access from a second server while the desktop app runs;
3. scheduled tasks that must run *every* task exactly once across instances
   (currently one instance runs all of them);
4. a second user, or a shared machine account.
