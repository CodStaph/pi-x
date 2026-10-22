/**
 * The session's activity phase as a pure state machine.
 *
 * `AgentSessionWrapper.isRunning()` currently derives "busy" from five sources
 * read live off the SDK (`pendingPromptCount`, `isStreaming`, `isCompacting`,
 * `isBashRunning`, `isIdle`). That works, but it is a *polling* answer: the
 * states the user can see — admitted but not started, retrying, compacting,
 * summarizing a branch, running a shell command, replacing the session — are not
 * named anywhere, so nothing can reason about them or test them without an SDK.
 *
 * This module names them and derives them from the event stream instead. It runs
 * **alongside** the flags first (stage B of docs/architecture-improvement-plan):
 * `AgentSessionWrapper.advancePhase()` folds every signal through `reducePhase()`
 * and compares the result with `isRunning()`, so a missed transition shows up as
 * a mismatch instead of a subtly wrong sidebar.
 *
 * Two deliberate asymmetries:
 *
 *   - **Busy is sticky through `agent_end`.** The post-run pipeline (auto-retry,
 *     compaction, branch summaries, queued continuations) keeps running after
 *     `agent_end`, and only `agent_settled` / a settled prompt / a finished shell
 *     command end the turn. Reporting idle early is the failure that evicts or
 *     shuts a wrapper mid-run.
 *   - **A mismatch in the safe direction is not a warning.** When the flags say
 *     idle but the phase says busy, the machine is merely conservative; only
 *     "flags busy, phase idle" is risky (see `compareBusy`).
 */

/** Auto-retry / summarization-retry backoff, as the SDK reports it. */
export interface RetryState {
  attempt: number | null;
  max: number | null;
}

export type SessionPhase =
  | { kind: "idle" }
  /** A prompt was accepted but the SDK has not started a run yet. */
  | { kind: "admitted" }
  | { kind: "prompting"; retry?: RetryState }
  | { kind: "compacting"; reason?: string; retry?: RetryState }
  /** A summarizing branch switch is in flight (pi's "Summarize branch?"). */
  | { kind: "branch-summary"; retry?: RetryState }
  | { kind: "bash" }
  /** `fork` / `clone` is copying the session. */
  | { kind: "replacing"; replacement: "fork" | "clone" };

/** Everything that can move the phase: SDK events plus wrapper-level signals. */
export type SessionSignal =
  // wrapper
  | { type: "prompt-admitted" }
  | { type: "prompt-settled" }
  | { type: "bash-started" }
  | { type: "bash-finished" }
  | { type: "branch-summary-started" }
  | { type: "branch-summary-finished" }
  | { type: "replacement-started"; replacement: "fork" | "clone" }
  | { type: "replacement-finished" }
  // SDK
  | { type: "agent-start" }
  | { type: "agent-end"; willRetry?: boolean }
  | { type: "agent-settled" }
  | { type: "compaction-start"; reason?: string }
  | { type: "compaction-end"; willRetry?: boolean }
  | { type: "auto-retry-start"; attempt?: number; maxAttempts?: number }
  | { type: "auto-retry-end" }
  | { type: "summarization-retry-scheduled"; attempt?: number; maxAttempts?: number }
  | { type: "summarization-retry-finished" };

export const IDLE_PHASE: SessionPhase = { kind: "idle" };

/** The single busy predicate; `isRunning()` will call this once stage B settles. */
export function isBusy(phase: SessionPhase): boolean {
  return phase.kind !== "idle";
}

function retryOf(phase: SessionPhase): RetryState | undefined {
  return "retry" in phase ? phase.retry : undefined;
}

function withRetry(phase: SessionPhase, retry: RetryState): SessionPhase {
  switch (phase.kind) {
    case "prompting":
    case "compacting":
    case "branch-summary":
      return { ...phase, retry };
    case "idle":
      // A retry without a run belongs to the post-run pipeline the flags still
      // report as busy, so treat it as prompting rather than dropping it.
      return { kind: "prompting", retry };
    default:
      return phase;
  }
}

function withoutRetry(phase: SessionPhase): SessionPhase {
  switch (phase.kind) {
    case "prompting":
      return phase.retry === undefined ? phase : { kind: "prompting" };
    case "compacting":
      return phase.retry === undefined
        ? phase
        : { kind: "compacting", ...(phase.reason ? { reason: phase.reason } : {}) };
    case "branch-summary":
      return phase.retry === undefined ? phase : { kind: "branch-summary" };
    default:
      return phase;
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retryFrom(attempt: unknown, max: unknown): RetryState {
  return { attempt: optionalNumber(attempt) ?? null, max: optionalNumber(max) ?? null };
}

/**
 * Fold one signal into the phase.
 *
 * The rules are ordered by what the SDK guarantees: `agent_end` may be followed
 * by retries, compaction or summarization (so it stays busy), while
 * `agent_settled` is the SDK's own "everything finished" answer.
 */
export function reducePhase(phase: SessionPhase, signal: SessionSignal): SessionPhase {
  switch (signal.type) {
    case "prompt-admitted":
      // A second prompt queued onto a running turn leaves the phase running.
      return phase.kind === "idle" ? { kind: "admitted" } : phase;

    case "prompt-settled":
      // The SDK resolves a prompt promise only once the run is fully idle.
      return phase.kind === "admitted" || phase.kind === "prompting" ? { kind: "idle" } : phase;

    case "agent-start":
      return { kind: "prompting" };

    case "agent-end": {
      if (signal.willRetry) {
        return { kind: "prompting", retry: retryOf(phase) ?? { attempt: null, max: null } };
      }
      // Stay busy through the post-run pipeline; `agent_settled` ends the turn.
      return phase.kind === "compacting" ? phase : { kind: "prompting" };
    }

    case "agent-settled":
      return { kind: "idle" };

    case "compaction-start":
      return { kind: "compacting", ...(signal.reason ? { reason: signal.reason } : {}) };

    case "compaction-end":
      if (signal.willRetry) return { kind: "prompting" };
      return phase.kind === "compacting" ? { kind: "idle" } : phase;

    case "auto-retry-start":
      return {
        kind: "prompting",
        retry: retryFrom(signal.attempt, signal.maxAttempts),
      };

    case "auto-retry-end":
      // Success or failure, the run is not over until the SDK settles.
      return withoutRetry({ kind: "prompting" });

    case "summarization-retry-scheduled":
      return withRetry(phase, retryFrom(signal.attempt, signal.maxAttempts));

    case "summarization-retry-finished":
      return withoutRetry(phase);

    case "bash-started":
      return { kind: "bash" };

    case "bash-finished":
      return phase.kind === "bash" ? { kind: "idle" } : phase;

    case "branch-summary-started":
      return { kind: "branch-summary" };

    case "branch-summary-finished":
      return phase.kind === "branch-summary" ? { kind: "idle" } : phase;

    case "replacement-started":
      return { kind: "replacing", replacement: signal.replacement };

    case "replacement-finished":
      return phase.kind === "replacing" ? { kind: "idle" } : phase;
  }
}

/**
 * Map an SDK event onto a phase signal, or null when it cannot move the phase.
 *
 * Kept separate from `reducePhase` so the mapping is testable without an SDK and
 * so `lib/pi/events.ts` remains the one list of *client-visible* events: this is
 * the server-side subset that describes activity.
 */
export function signalFromAgentEvent(event: { type: string; [key: string]: unknown }): SessionSignal | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent-start" };
    case "agent_end":
      return { type: "agent-end", willRetry: event.willRetry === true };
    case "agent_settled":
      return { type: "agent-settled" };
    case "compaction_start":
      return {
        type: "compaction-start",
        ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
      };
    case "compaction_end":
      return { type: "compaction-end", willRetry: event.willRetry === true };
    case "auto_retry_start":
      return {
        type: "auto-retry-start",
        ...(optionalNumber(event.attempt) !== undefined ? { attempt: event.attempt as number } : {}),
        ...(optionalNumber(event.maxAttempts) !== undefined ? { maxAttempts: event.maxAttempts as number } : {}),
      };
    case "auto_retry_end":
      return { type: "auto-retry-end" };
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
      // `attempt_start` repeats the attempt number; folding both keeps the
      // retry counter visible across the two events.
      return {
        type: "summarization-retry-scheduled",
        ...(optionalNumber(event.attempt) !== undefined ? { attempt: event.attempt as number } : {}),
        ...(optionalNumber(event.maxAttempts) !== undefined ? { maxAttempts: event.maxAttempts as number } : {}),
      };
    case "summarization_retry_finished":
      return { type: "summarization-retry-finished" };
    default:
      return null;
  }
}

/** The flag-based inputs `isRunning()` uses, for seeding the machine mid-run. */
export interface FlagSnapshot {
  streaming?: boolean;
  compacting?: boolean;
  bashRunning?: boolean;
  /** `sdkReportsBusy()` — retry backoff, summarization, queued continuations. */
  sdkBusy?: boolean;
  pendingPrompts?: number;
}

/**
 * Seed a phase from the flags.
 *
 * A wrapper can be reopened while the session is already running, and an event
 * the machine never saw would otherwise be compared against a stale `idle`.
 */
export function phaseFromFlags(flags: FlagSnapshot): SessionPhase {
  if (flags.bashRunning) return { kind: "bash" };
  if (flags.compacting) return { kind: "compacting" };
  if ((flags.pendingPrompts ?? 0) > 0) return { kind: "admitted" };
  if (flags.streaming || flags.sdkBusy) return { kind: "prompting" };
  return IDLE_PHASE;
}

export type PhaseMismatch = "risky" | "conservative";

declare global {
  /**
   * Process-wide mismatch counters, keyed by session id.
   *
   * Stage B asks for a release cycle of observation before `isRunning()` may trust
   * the machine; without an aggregate that observation cannot happen, because
   * `AgentSessionWrapper.getPhaseMismatches()` is only reachable from the wrapper
   * itself. `GET /api/agent/diagnostics` reads this.
   */
  var __piWebPhaseMismatches: Map<string, { risky: number; conservative: number }> | undefined;
}

function mismatchMap(): Map<string, { risky: number; conservative: number }> {
  if (!globalThis.__piWebPhaseMismatches) globalThis.__piWebPhaseMismatches = new Map();
  return globalThis.__piWebPhaseMismatches;
}

/** Record one disagreement for `sessionId` (called by the wrapper's advancePhase). */
export function notePhaseMismatch(kind: PhaseMismatch, sessionId: string): void {
  const map = mismatchMap();
  const entry = map.get(sessionId) ?? { risky: 0, conservative: 0 };
  entry[kind] += 1;
  map.set(sessionId, entry);
}

export interface PhaseDiagnostics {
  risky: number;
  conservative: number;
  /** Sessions that ever disagreed, worst first. */
  sessions: Array<{ sessionId: string; risky: number; conservative: number }>;
}

/** Totals plus per-session detail; empty means the machine has never disagreed. */
export function getPhaseDiagnostics(): PhaseDiagnostics {
  const sessions = [...mismatchMap().entries()]
    .map(([sessionId, counts]) => ({ sessionId, ...counts }))
    .sort((a, b) => b.risky - a.risky || b.conservative - a.conservative);
  return {
    risky: sessions.reduce((sum, entry) => sum + entry.risky, 0),
    conservative: sessions.reduce((sum, entry) => sum + entry.conservative, 0),
    sessions,
  };
}

/** Test hook: forget every recorded mismatch. */
export function resetPhaseDiagnostics(): void {
  mismatchMap().clear();
}

/**
 * Compare the flag-based answer with the event-driven phase.
 *
 * `risky` — the flags say busy while the phase says idle — is the direction that
 * evicts or shuts a wrapper mid-run, so the shadow comparison warns about it.
 * `conservative` is the opposite and only counted.
 */
export function compareBusy(flagsSayBusy: boolean, phase: SessionPhase): PhaseMismatch | null {
  const phaseSaysBusy = isBusy(phase);
  if (flagsSayBusy === phaseSaysBusy) return null;
  return flagsSayBusy ? "risky" : "conservative";
}
