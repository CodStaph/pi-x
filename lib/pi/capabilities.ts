/**
 * Which AgentSession members this SDK build actually exposes, and the one place
 * that adapts to the differences.
 *
 * pi-web pins one SDK version per release, but the SDK moves fast: 0.86 added
 * `isIdle` (and with it the whole retry/branch-summary/queued-turn pipeline),
 * `abortRetry`, `abortBranchSummary` and the steering/follow-up modes; the
 * extension UI context became re-bindable after `reload()`. None of that is
 * negotiable through a version number — the SDK does not expose one at runtime
 * in a way that maps to features — so each difference is detected from the
 * session object itself.
 *
 * Two rules:
 *
 *   - **Only this module asks "does the SDK have X".** Call sites get a boolean
 *     from `detectSessionCapabilities()` or call one of the optional-call
 *     helpers below; `?.()` and `typeof … === "function"` at a call site mean the
 *     adaptation escaped again.
 *   - **The fallback is the old behaviour, silently.** A missing `setSteeringMode`
 *     must not turn into an error the user sees; `abort_retry` on an SDK without
 *     it is a no-op. `lib/pi/capabilities.test.mjs` pins both.
 *
 * Two SDK behaviours deliberately stay out of here because they need no probe:
 * `setThinkingLevel()` clamps to the levels the model supports (pi >= 0.86), so
 * no call site may clamp by hand; and the compaction events are `compaction_start`
 * / `compaction_end` only (`lib/pi/events.ts` lists what the client handles, and
 * the legacy `auto_compaction_*` names must not come back). Both are guarded by
 * tests instead of a runtime check.
 */

import type { AgentSessionLike } from "../pi-types";

export interface SessionCapabilities {
  /** `isIdle` covers retry backoff, branch summaries and queued turns (pi >= 0.86). */
  readonly idleFlag: boolean;
  /** `abortRetry()` — cancels an in-flight auto-retry backoff. */
  readonly abortRetry: boolean;
  /** `abortBranchSummary()` — withdraws a running branch summary. */
  readonly abortsBranchSummary: boolean;
  /** `setSteeringMode()` / `setFollowUpMode()` — queued-message delivery mode. */
  readonly steeringModes: boolean;
  readonly followUpModes: boolean;
  /** `bindExtensions()` exists, so the UI context can be rebound after `reload()`. */
  readonly rebindableExtensions: boolean;
}

/**
 * Detect once per session instance. Every field is a `typeof` check on the
 * SDK object, so this is cheap enough to run in a constructor.
 */
export function detectSessionCapabilities(session: AgentSessionLike): SessionCapabilities {
  return {
    // `in` rather than a value check: an undefined reading still means the SDK
    // reports the flag, and `idleFlag` only decides whether to consult it.
    idleFlag: "isIdle" in session,
    abortRetry: typeof session.abortRetry === "function",
    abortsBranchSummary: typeof session.abortBranchSummary === "function",
    steeringModes: typeof session.setSteeringMode === "function",
    followUpModes: typeof session.setFollowUpMode === "function",
    rebindableExtensions: typeof session.bindExtensions === "function",
  };
}

/**
 * Whether the SDK reports work the four visible flags cannot see.
 *
 * pi >= 0.86 keeps `isIdle` false through auto-retry backoff, branch summaries
 * and queued continuations, where `isStreaming`/`isCompacting`/`isBashRunning`
 * are all false. Builds without the flag return false and let the caller fall
 * back to those flags.
 */
export function sdkReportsBusy(
  session: AgentSessionLike,
  capabilities: SessionCapabilities,
): boolean {
  return capabilities.idleFlag && session.isIdle === false;
}

/** Cancel an in-flight auto-retry backoff. Returns false when the SDK cannot. */
export function abortRetry(session: AgentSessionLike): boolean {
  if (typeof session.abortRetry !== "function") return false;
  session.abortRetry();
  return true;
}

/** Withdraw a running branch summary. Returns false when the SDK cannot. */
export function abortBranchSummary(session: AgentSessionLike): boolean {
  if (typeof session.abortBranchSummary !== "function") return false;
  session.abortBranchSummary();
  return true;
}

export function setSteeringMode(session: AgentSessionLike, mode: "all" | "one-at-a-time"): boolean {
  if (typeof session.setSteeringMode !== "function") return false;
  session.setSteeringMode(mode);
  return true;
}

export function setFollowUpMode(session: AgentSessionLike, mode: "all" | "one-at-a-time"): boolean {
  if (typeof session.setFollowUpMode !== "function") return false;
  session.setFollowUpMode(mode);
  return true;
}

/** Whether the extension UI context can be rebound through `bindExtensions()`. */
export function hasBindExtensions(session: AgentSessionLike): boolean {
  return typeof session.bindExtensions === "function";
}

/**
 * The prompt the last request actually carried.
 *
 * `agent.state.systemPrompt` is replayed from the transcript's system messages
 * since pi 0.86 and is read-only — assigning it throws at runtime, and `tsc`
 * cannot see that through `AgentSessionLike`. Reading it here keeps the write
 * ban at one boundary instead of each call site remembering.
 */
export function replayStateSystemPrompt(session: AgentSessionLike): string | undefined {
  return session.agent.state?.systemPrompt;
}
