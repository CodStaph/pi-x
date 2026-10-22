# Session state authority

Which source decides each part of "is this session busy", who may update it, and
what the browser sees. Written for stage B of
`docs/architecture-improvement-plan.zh-CN.md`; the machine described here is
`lib/session/state.ts`.

## Why this document exists

`AgentSessionWrapper.isRunning()` answers from five live SDK readings
(`pendingPromptCount`, `isStreaming`, `isCompacting`, `isBashRunning`,
`isIdle`). That answer drives wrapper eviction (`evictIfDiskAhead`), idle
shutdown, the sidebar spinner and `hasBusyRpcSessionForCwd()`. Getting it wrong
is expensive in both directions:

- **too early idle** → the wrapper is evicted or shut down mid-run, losing the
  run's streamed output and the session's extension state;
- **too late idle** → the sidebar spinner sticks and the process never releases
  the session.

So every dimension below has exactly one authority. When two of them disagree,
the one in this table wins and the other is a bug.

## Dimensions

| Dimension | Authority | Updated by | Reaches the browser as |
|---|---|---|---|
| SDK run | SDK (`isStreaming`, `agent_start` / `agent_end` / `agent_settled`) | SDK events | `agent_start` / `agent_end` / `agent_settled`; sidebar running set |
| Admitted prompt | wrapper (`pendingPromptCount`) | `prompt` admission, `finishPrompt()` | `get_state.isPromptRunning`; sidebar running set via `notifyRunningChange()` |
| Compaction | SDK (`isCompacting`, `compaction_start` / `compaction_end`) | SDK events | `isStreaming`-like updates; sidebar running set |
| Shell command | SDK (`isBashRunning`) | `executeBash()` boundaries — it emits no start/end event | `bash_execution_update` deltas; sidebar running set |
| Auto-retry backoff | SDK (`isIdle === false`; `auto_retry_start` / `auto_retry_end`) | SDK events | retry banner; sidebar running set |
| Summarization retry | SDK (`isIdle === false`; `summarization_retry_*`) | SDK events | "Compacting… (retry n/m)" |
| Branch summary | wrapper (blocking RPC) + SDK retry events | `navigate_tree` with `summarize` | branch-switch progress strip |
| Session replacement | wrapper (`sessionReplacement`) | `withSessionReplacement()` | none — other commands are refused |
| Session liveness | wrapper (`_alive`, `closing`) | `shutdown()` / `destroy()` | `get_state.running` |
| Client run state | `hooks/useAgentSession.ts` (`agentRunningRef`, run ids) | SSE events, lease, reconcile | chat UI |

Two rules follow from the table:

1. **The server never derives a dimension from the browser.** The client mirrors;
   it does not decide. A client rebuild of this table (`agentRunning` from
   `agentPhase`, or from the sidebar's running set alone) is a second source of
   truth and will drift.
2. **`isIdle` is not redundant with the four flags.** It stays `false` through
   retry backoff, branch summaries and queued continuations, where all four are
   false. That is why `lib/pi/capabilities.ts` exposes `sdkReportsBusy()` and why
   dropping it re-introduces mid-retry eviction.

## The shadow phase machine (stage B)

`lib/session/state.ts` names the phases these dimensions produce
(`idle` / `admitted` / `prompting` / `compacting` / `branch-summary` / `bash` /
`replacing`) and derives them **from the event stream only**. It currently runs in
shadow mode:

- `AgentSessionWrapper.advancePhase()` folds every signal through `reducePhase()`
  and compares the result with `isRunning()`.
- A mismatch in the dangerous direction (flags busy, phase idle) warns once in
  development; the opposite direction is only counted
  (`getPhaseMismatches()`), because `agent_end` deliberately keeps the phase busy
  until the SDK settles while the flags may already read idle.
- `isRunning()` still answers from the flags. Nothing reads `phase` for
  behaviour.

**Exit condition for shadow mode:** the aggregate `risky` count stays at 0 across a
release cycle of real use, including retries, mid-run compaction, branch summaries,
Stop, `!command`, fork/clone and a page refresh mid-stream.

That count is now readable: `GET /api/agent/diagnostics` returns

```json
{ "sessionPhase": { "mode": "shadow", "risky": 0, "conservative": 0, "sessions": [] } }
```

totalled per process and per session, `risky` first. Without this endpoint the
condition could never be checked — `getPhaseMismatches()` only lives on the wrapper.

**The switch already exists and defaults to the flags.**
`PI_WEB_SESSION_PHASE=phase` makes `isRunning()` return `isBusy(this.phase)`
(keeping `_alive` in the expression); `AgentSessionWrapper.phaseDrivesRunning()`
and the diagnostics endpoint report which mode is active. Do not flip the default
until the counter says 0.

### Why the test suite cannot prove the switch

Running the runtime suites with `PI_WEB_SESSION_PHASE=phase` fails three tests, all
for the same reason: those suites drive **mock** sessions that flip
`isStreaming`/`isIdle` booleans directly and never emit `agent_start` /
`agent_end`. The machine learns state from events, so under mocks it stays idle —
e.g. `PI_WEB_IDLE_TIMEOUT_MS=0 keeps a session alive after Stop unwinds its run`
sees `isRunning()` false after `abort` and starts the forced cleanup.

That is a property of the fixtures, not evidence that the machine is wrong — and
also not evidence that it is right. It means equivalence has to be observed against
the real SDK, which is exactly what the counter is for. Making the mocks emit
events would be a rewrite of the runtime suites, and would weaken them (they exist
to pin behaviour under those very stubs).

**Do not** add a transition by editing `isRunning()`: the machine is the place
for that, and `lib/session/state.test.mjs` pins the rules.

## Known asymmetries

- `agent_end` keeps the phase busy until `agent_settled` / a settled prompt. This
  is intentional and the reason the conservative direction is not treated as a
  bug.
- A retry with no current run is folded to `prompting` rather than dropped, since
  the flags still report the post-run pipeline as busy.
- Bash has no start/end SDK event; `bash-started` / `bash-finished` come from the
  RPC command boundary (`case "bash"`), which is also where
  `notifyRunningChange()` is called for it.
