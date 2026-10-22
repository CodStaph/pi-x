# Stage C2-3 / C2-4 — splitting the session runtime

Status: **designed, not executed.** This records what the split needs before it can
be done safely, so the next attempt does not rediscover it. `P2` of
`docs/architecture-improvement-plan.zh-CN.md` asks for `lib/session/start.ts` and
`lib/session/wrapper.ts`; both are blocked on the dependency below, not on effort.

## What is there now

| Piece | Lines | Notes |
|---|---:|---|
| `AgentSessionWrapper` class | 336–2310 (**1974**) | `lib/rpc-manager.ts` |
| `startRpcSession()` | 2524–2753 (**230**) | same file |
| `lib/rpc-manager.ts` total | 2754 | down from 2801 after C2-1 |

Couplings that make a plain `git mv` insufficient:

1. **A cycle.** `startRpcSession()` constructs the wrapper (`new AgentSessionWrapper(...)`),
   and the wrapper calls back into `startRpcSession()` twice:
   - `createExtensionCommandContextActions().newSession` (extension `ctx.newSession`);
   - `newSessionForExtension()` (`__ext__…` keys).
2. **Sixteen test files** construct the wrapper directly:
   `lib/rpc-manager*.test.mjs`, `lib/rpc-session-info.test.mjs`,
   `lib/session-reader-external-write.test.mjs`, and three integration suites
   (`builtin-extensions`, `mcp-host`, `mcp-read-only-policy`). Any constructor-signature
   change touches all of them.
3. **Shared module-level symbols** the class uses and other modules/tests import:
   `IDLE_RESET_EVENT_TYPES`, `SESSION_IDLE_TIMEOUT_MS`, `SESSION_SHUTDOWN_DEADLINE_MS`
   (via `resolveSessionShutdownDeadlineMs`, which has its own test),
   `MCP_WAIT_STOPPED_MESSAGE`, `PlainTextTheme`, `resolveActiveToolNames`,
   `closingRpcSessionWait`.

## The dependency that has to break first

The cycle is real, not stylistic: `start` needs the class, the class needs `start`.
Three ways out, in increasing order of blast radius:

**A. Inject the start function (recommended).** Add to `AgentSessionWrapperOptions`:

```ts
/** Starts a replacement session; supplied by lib/session/start.ts (breaks the cycle). */
startSession?: (sessionId: string, sessionFile: string, cwd: string | undefined, options?: RpcSessionStartOptions) =>
  Promise<{ session: AgentSessionWrapper; realSessionId: string }>;
```

`newSessionForExtension()` and `newSession` use it and throw a named error when it is
absent (only extension-driven replacement needs it). `startRpcSession()` passes
itself. The 16 test files keep working because the parameter is optional and only the
extension-session-actions suite exercises those two paths (that suite must pass a stub
and assert it was called).

**B. Keep both in one file.** No split; the file stays ~2750 lines. Rejected by the
plan's goal (a file small enough that a merge conflict is local), and it leaves the
whole session runtime on one upstream-owned path.

**C. Dynamic `import()` inside the wrapper.** Breaks the cycle with no signature
change, but hides the dependency from `tsc` and from a reader. Rejected.

## Execution order (when the window opens)

Each step is a separate commit; `lib/rpc-manager.ts` keeps re-exports so no call site
changes in the same step.

1. **Add `startSession` to the wrapper options (no move).** Wire `startRpcSession()`
   through it. Acceptance: `npm test` unchanged, plus one new assertion in
   `lib/rpc-manager-extension-session-actions.test.mjs` that the injected function is
   used instead of the module import.
2. **Move the class to `lib/session/wrapper.ts`.** Move the six shared symbols with it
   (`IDLE_RESET_EVENT_TYPES`, the two timeout resolvers, `MCP_WAIT_STOPPED_MESSAGE`,
   `PlainTextTheme`, `resolveActiveToolNames`) and re-export the ones tests import.
   Acceptance: `rpc-manager.ts` loses ~2000 lines, `tsc` passes, all 16 suites pass
   unchanged, `npm run drift` recomputed.
3. **Move `startRpcSession()` + `closingRpcSessionWait()` to `lib/session/start.ts`.**
   Acceptance: `rpc-manager.ts` ≤ 400 lines; `export { startRpcSession } from …` keeps
   `app/api/**` imports working.
4. **Then C2-2 (`lib/session/commands/*`).** The command switch can only move once the
   wrapper is its own module with an explicit surface; before that a handler would need
   `ctx: any` and would undo stage A's typing.

## Why it is not done yet

- **Step 1 changes a constructor signature** used by 16 test files. It is mechanical but
  must land on its own, and it is the kind of change a follow-up upstream merge would
  conflict with in `lib/rpc-manager.ts` — the file the fork already drifts 652
  structural lines in.
- **The plan says so.** Stage C's C3 requires "错开合并窗口"; `component-updates.yml`
  is `workflow_dispatch`, so there is no automated signal that a merge is not imminent.
  Moving 2000 lines immediately before one is the worst case in `fork-ownership.json`'s
  risk model ("merges cleanly while being wrong").
- **No user-visible payoff.** The split is a maintainability change; `npm test` passing
  is the only proof it worked. Doing it without a quiet window trades a small, known
  cost (a big file) for a larger, unknown one (a silent merge conflict).

## What "done" looks like

| Check | Target |
|---|---|
| `lib/rpc-manager.ts` | ≤ 400 lines (registry, re-exports, subagent controller) |
| `lib/session/wrapper.ts` | the class + its constants, no `rpc-manager` import |
| `lib/session/start.ts` | `startRpcSession()` + `closingRpcSessionWait()` |
| constructor | one optional `startSession`, one test proving it is used |
| call sites | none changed (`rpc-manager.ts` re-exports) |
| `npm run drift` / `check:ownership` | recomputed, still green |
