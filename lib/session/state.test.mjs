// Pins lib/session/state.ts: the phase machine, and the shadow-mode contract the
// wrapper runs it under (flags still answer isRunning(); only the risky
// direction warns).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  IDLE_PHASE,
  compareBusy,
  getPhaseDiagnostics,
  isBusy,
  notePhaseMismatch,
  phaseFromFlags,
  reducePhase,
  resetPhaseDiagnostics,
  signalFromAgentEvent,
} = await jiti.import("./state.ts");

const stateSource = readFileSync(new URL("./state.ts", import.meta.url), "utf8");
const rpcManagerSource = readFileSync(new URL("../rpc-manager.ts", import.meta.url), "utf8");

/** Fold a list of signals, returning every phase the machine passed through. */
function run(signals) {
  const phases = [IDLE_PHASE];
  for (const signal of signals) phases.push(reducePhase(phases[phases.length - 1], signal));
  return phases;
}

const last = (signals) => run(signals).at(-1);

test("a normal turn runs idle -> prompting -> idle", () => {
  const phases = run([
    { type: "prompt-admitted" },
    { type: "agent-start" },
    { type: "agent-end" },
    { type: "agent-settled" },
  ]);

  assert.deepEqual(phases.map((phase) => phase.kind), ["idle", "admitted", "prompting", "prompting", "idle"]);
  assert.deepEqual(phases.map(isBusy), [false, true, true, true, false]);
});

test("agent_end alone does not end the turn", () => {
  // The post-run pipeline (compaction, retries, queued continuations) keeps the
  // session busy; reporting idle here is what evicts a wrapper mid-run.
  assert.equal(isBusy(last([{ type: "prompt-admitted" }, { type: "agent-start" }, { type: "agent-end" }])), true);
});

test("retry backoff counts as busy and carries the attempt counter", () => {
  const phase = last([
    { type: "prompt-admitted" },
    { type: "agent-start" },
    { type: "agent-end", willRetry: true },
    { type: "auto-retry-start", attempt: 2, maxAttempts: 5 },
  ]);
  assert.equal(phase.kind, "prompting");
  assert.deepEqual(phase.retry, { attempt: 2, max: 5 });
  assert.equal(isBusy(phase), true);

  const finished = reducePhase(phase, { type: "auto-retry-end" });
  assert.equal(finished.kind, "prompting");
  assert.equal("retry" in finished, false);
  assert.equal(isBusy(finished), true);
});

test("compaction is busy, and a retrying compaction stays busy", () => {
  const compacting = reducePhase(IDLE_PHASE, { type: "compaction-start", reason: "manual" });
  assert.deepEqual(compacting, { kind: "compacting", reason: "manual" });
  assert.equal(isBusy(compacting), true);

  const afterClean = reducePhase(compacting, { type: "compaction-end" });
  assert.equal(afterClean.kind, "idle");

  const retrying = reducePhase(compacting, { type: "compaction-end", willRetry: true });
  assert.equal(retrying.kind, "prompting");
  assert.equal(isBusy(retrying), true);
});

test("summarization retries mark the phase without changing its kind", () => {
  const compacting = reducePhase(IDLE_PHASE, { type: "compaction-start" });
  const scheduled = reducePhase(compacting, {
    type: "summarization-retry-scheduled",
    attempt: 1,
    maxAttempts: 3,
  });
  assert.equal(scheduled.kind, "compacting");
  assert.deepEqual(scheduled.retry, { attempt: 1, max: 3 });

  const finished = reducePhase(scheduled, { type: "summarization-retry-finished" });
  assert.equal(finished.kind, "compacting");
  assert.equal("retry" in finished, false);
});

test("Stop ends the turn immediately", () => {
  const running = last([{ type: "prompt-admitted" }, { type: "agent-start" }]);
  assert.equal(isBusy(running), true);
  // `abort()` unwinds the run and the SDK settles it.
  assert.equal(isBusy(reducePhase(running, { type: "agent-settled" })), false);
});

test("a settled prompt returns admitted/prompting to idle but leaves other phases alone", () => {
  assert.equal(reducePhase({ kind: "admitted" }, { type: "prompt-settled" }).kind, "idle");
  assert.equal(reducePhase({ kind: "prompting" }, { type: "prompt-settled" }).kind, "idle");
  assert.equal(reducePhase({ kind: "compacting" }, { type: "prompt-settled" }).kind, "compacting");
  assert.equal(reducePhase({ kind: "bash" }, { type: "prompt-settled" }).kind, "bash");
});

test("queued prompt on a running turn keeps it running", () => {
  const running = last([{ type: "prompt-admitted" }, { type: "agent-start" }]);
  assert.equal(reducePhase(running, { type: "prompt-admitted" }).kind, "prompting");
});

test("branch summaries, shell commands and session replacement are their own phases", () => {
  const summary = last([{ type: "branch-summary-started" }]);
  assert.equal(summary.kind, "branch-summary");
  assert.equal(isBusy(summary), true);
  assert.equal(reducePhase(summary, { type: "branch-summary-finished" }).kind, "idle");

  const bash = last([{ type: "bash-started" }]);
  assert.equal(bash.kind, "bash");
  assert.equal(reducePhase(bash, { type: "bash-finished" }).kind, "idle");

  const replacing = last([{ type: "replacement-started", replacement: "fork" }]);
  assert.deepEqual(replacing, { kind: "replacing", replacement: "fork" });
  assert.equal(isBusy(replacing), true);
  assert.equal(reducePhase(replacing, { type: "replacement-finished" }).kind, "idle");
});

test("finishing a phase it is not in is a no-op", () => {
  assert.equal(reducePhase(IDLE_PHASE, { type: "bash-finished" }).kind, "idle");
  assert.equal(reducePhase(IDLE_PHASE, { type: "branch-summary-finished" }).kind, "idle");
  assert.equal(reducePhase(IDLE_PHASE, { type: "replacement-finished" }).kind, "idle");
  assert.equal(reducePhase(IDLE_PHASE, { type: "prompt-settled" }).kind, "idle");
});

test("every reachable phase is either idle or busy, consistently", () => {
  const signals = [
    { type: "prompt-admitted" },
    { type: "agent-start" },
    { type: "agent-end" },
    { type: "agent-end", willRetry: true },
    { type: "agent-settled" },
    { type: "compaction-start" },
    { type: "compaction-end" },
    { type: "compaction-end", willRetry: true },
    { type: "auto-retry-start", attempt: 1, maxAttempts: 2 },
    { type: "auto-retry-end" },
    { type: "summarization-retry-scheduled" },
    { type: "summarization-retry-finished" },
    { type: "bash-started" },
    { type: "bash-finished" },
    { type: "branch-summary-started" },
    { type: "branch-summary-finished" },
    { type: "replacement-started", replacement: "clone" },
    { type: "replacement-finished" },
    { type: "prompt-settled" },
  ];

  let phase = IDLE_PHASE;
  for (const signal of signals) {
    phase = reducePhase(phase, signal);
    assert.equal(isBusy(phase), phase.kind !== "idle", `isBusy disagrees with ${signal.type}`);
  }
});

test("signalFromAgentEvent maps only the activity events", () => {
  assert.deepEqual(signalFromAgentEvent({ type: "agent_start" }), { type: "agent-start" });
  assert.deepEqual(signalFromAgentEvent({ type: "agent_end", willRetry: true }), { type: "agent-end", willRetry: true });
  assert.deepEqual(signalFromAgentEvent({ type: "agent_end" }), { type: "agent-end", willRetry: false });
  assert.deepEqual(signalFromAgentEvent({ type: "agent_settled" }), { type: "agent-settled" });
  assert.deepEqual(signalFromAgentEvent({ type: "compaction_start", reason: "manual" }), {
    type: "compaction-start",
    reason: "manual",
  });
  assert.deepEqual(signalFromAgentEvent({ type: "compaction_end", willRetry: true }), {
    type: "compaction-end",
    willRetry: true,
  });
  assert.deepEqual(signalFromAgentEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 4 }), {
    type: "auto-retry-start",
    attempt: 2,
    maxAttempts: 4,
  });
  assert.deepEqual(signalFromAgentEvent({ type: "auto_retry_end" }), { type: "auto-retry-end" });

  // Both summarization events fold into the same retry marker.
  assert.deepEqual(signalFromAgentEvent({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3 }), {
    type: "summarization-retry-scheduled",
    attempt: 1,
    maxAttempts: 3,
  });
  assert.deepEqual(signalFromAgentEvent({ type: "summarization_retry_attempt_start", attempt: 2 }), {
    type: "summarization-retry-scheduled",
    attempt: 2,
  });
  assert.deepEqual(signalFromAgentEvent({ type: "summarization_retry_finished" }), {
    type: "summarization-retry-finished",
  });

  // Messages, tool calls and pi-web's own events carry no phase information.
  for (const type of ["message_start", "message_update", "message_end", "tool_execution_start", "queue_update", "prompt_done"]) {
    assert.equal(signalFromAgentEvent({ type }), null);
  }
});

test("phaseFromFlags seeds a reopened wrapper", () => {
  assert.deepEqual(phaseFromFlags({}), IDLE_PHASE);
  assert.equal(phaseFromFlags({ bashRunning: true, streaming: true }).kind, "bash");
  assert.equal(phaseFromFlags({ compacting: true, streaming: true }).kind, "compacting");
  assert.equal(phaseFromFlags({ pendingPrompts: 1, streaming: true }).kind, "admitted");
  assert.equal(phaseFromFlags({ streaming: true }).kind, "prompting");
  // The SDK flag is what makes retry backoff visible to a reattached wrapper.
  assert.equal(phaseFromFlags({ sdkBusy: true }).kind, "prompting");
});

test("compareBusy warns only in the dangerous direction", () => {
  assert.equal(compareBusy(true, { kind: "prompting" }), null);
  assert.equal(compareBusy(false, IDLE_PHASE), null);
  // Flags busy, phase idle: this is what would evict the wrapper mid-run.
  assert.equal(compareBusy(true, IDLE_PHASE), "risky");
  // Phase busy, flags idle: conservative, counted but not warned.
  assert.equal(compareBusy(false, { kind: "prompting" }), "conservative");
});

test("the module stays free of SDK imports", () => {
  assert.doesNotMatch(stateSource, /@earendil-works/);
  assert.match(stateSource, /export function isBusy/);
});

test("the wrapper runs the machine in shadow mode unless explicitly enabled", () => {
  // Stage B: the flags still answer `isRunning()` by default. The phase branch
  // exists but is behind an opt-in, because the mismatch counter has not been
  // observed in real use yet (docs/agents/state-authority.md).
  assert.match(
    rpcManagerSource,
    /const PHASE_DRIVES_RUNNING = process\.env\.PI_WEB_SESSION_PHASE === "phase";/,
  );

  const isRunning = rpcManagerSource.slice(
    rpcManagerSource.indexOf("isRunning(): boolean {"),
    rpcManagerSource.indexOf("evictIfDiskAhead"),
  );
  // The switch is the first thing after the liveness guard, and the default path
  // is unchanged.
  assert.match(isRunning, /if \(PHASE_DRIVES_RUNNING\) return isBusy\(this\.phase\);/);
  assert.match(isRunning, /this\.pendingPromptCount > 0/);
  assert.match(isRunning, /this\.inner\.isStreaming/);
  assert.match(isRunning, /this\.inner\.isCompacting/);
  assert.match(isRunning, /this\.inner\.isBashRunning/);
  assert.match(isRunning, /sdkReportsBusy\(this\.inner, this\.capabilities\)/);

  // The diagnostic compares against the flags in both modes; comparing with
  // isRunning() would make phase mode compare the machine with itself.
  assert.match(
    rpcManagerSource,
    /const flagsSayBusy = isBusy\(this\.phaseFromCurrentFlags\(\)\);/,
  );
  assert.match(rpcManagerSource, /notePhaseMismatch\(mismatch, this\.sessionId\);/);

  const wiring = [
    /signalFromAgentEvent\(event\)/,
    /this\.advancePhase\(\{ type: "prompt-admitted" \}\)/,
    /this\.advancePhase\(\{ type: "prompt-settled" \}\)/,
    /this\.advancePhase\(\{ type: "bash-started" \}\)/,
    /this\.advancePhase\(\{ type: "bash-finished" \}\)/,
    /this\.advancePhase\(\{ type: "branch-summary-started" \}\)/,
    /this\.advancePhase\(\{ type: "branch-summary-finished" \}\)/,
    /this\.advancePhase\(\{ type: "replacement-started", replacement \}\)/,
    /this\.advancePhase\(\{ type: "replacement-finished" \}\)/,
    // Seeding reads the flags directly: in phase mode isRunning() would answer
    // from the (still idle) machine and a mid-run reopen would never seed.
    /const seeded = this\.phaseFromCurrentFlags\(\);[\s\S]*?if \(seeded\.kind !== "idle"\) this\.phase = seeded;/,
  ];
  for (const pattern of wiring) assert.match(rpcManagerSource, pattern);

  assert.match(rpcManagerSource, /getActivityPhase\(\): SessionPhase/);
  assert.match(rpcManagerSource, /getPhaseMismatches\(\): \{ risky: number; conservative: number \}/);
  assert.match(rpcManagerSource, /mismatch === "conservative" \|\| this\.phaseMismatches\.risky > 1/);
});

test("mismatches are aggregated per session, worst first", () => {
  resetPhaseDiagnostics();
  try {
    assert.deepEqual(getPhaseDiagnostics(), { risky: 0, conservative: 0, sessions: [] });

    notePhaseMismatch("conservative", "s1");
    notePhaseMismatch("conservative", "s1");
    notePhaseMismatch("risky", "s2");
    notePhaseMismatch("conservative", "s2");

    const report = getPhaseDiagnostics();
    assert.equal(report.risky, 1);
    assert.equal(report.conservative, 3);
    assert.deepEqual(report.sessions, [
      { sessionId: "s2", risky: 1, conservative: 1 },
      { sessionId: "s1", risky: 0, conservative: 2 },
    ]);
  } finally {
    resetPhaseDiagnostics();
  }
});

test("the diagnostics reset clears every session", () => {
  notePhaseMismatch("risky", "s3");
  resetPhaseDiagnostics();
  assert.deepEqual(getPhaseDiagnostics(), { risky: 0, conservative: 0, sessions: [] });
});
