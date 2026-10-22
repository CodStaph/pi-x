// Pins scripts/measure-fork-drift.mjs's classifier: the two failure modes it
// distinguishes, and that the threshold/policy come from the manifest rather than
// from constants in the script.

import assert from "node:assert/strict";
import test from "node:test";

import { classifyDriftRows, driftProblems, riskForStructural } from "./measure-fork-drift.mjs";

function manifest(overrides = {}) {
  return {
    riskModel: { thresholds: { high: 250, medium: 30 } },
    autoPushPolicy: { blockOnRisk: ["high", "medium"] },
    driftedUpstreamFiles: {},
    ...overrides,
  };
}

const row = (file, structural) => ({ file, structural, cosmetic: 0, total: structural });

test("risk follows the manifest's thresholds", () => {
  const m = manifest();
  assert.equal(riskForStructural(0, m), "low");
  assert.equal(riskForStructural(29, m), "low");
  assert.equal(riskForStructural(30, m), "medium");
  assert.equal(riskForStructural(249, m), "medium");
  assert.equal(riskForStructural(250, m), "high");

  // Custom thresholds are honoured: the numbers are policy, not constants.
  const strict = manifest({ riskModel: { thresholds: { high: 10, medium: 5 } } });
  assert.equal(riskForStructural(10, strict), "high");
  assert.equal(riskForStructural(5, strict), "medium");
});

test("a recorded risk that no longer matches is stale", () => {
  const m = manifest({
    driftedUpstreamFiles: { "lib/a.ts": { risk: "medium" } },
  });
  const [classified] = classifyDriftRows([row("lib/a.ts", 300)], m);
  assert.equal(classified.risk, "high");
  assert.equal(classified.recordedRisk, "medium");
  assert.equal(classified.stale, true);
  assert.equal(classified.unrecorded, false);

  const [same] = classifyDriftRows([row("lib/a.ts", 40)], m);
  assert.equal(same.stale, false);
  assert.equal(same.unrecorded, false);

  // A recorded file that stopped drifting (now low) is stale too: the entry lies.
  const [shrunk] = classifyDriftRows([row("lib/a.ts", 3)], m);
  assert.equal(shrunk.risk, "low");
  assert.equal(shrunk.stale, true);
});

test("meaningful drift in an unrecorded file is unrecorded", () => {
  const m = manifest();

  const [medium] = classifyDriftRows([row("lib/b.ts", 40)], m);
  assert.equal(medium.unrecorded, true, "autoPushPolicy would block on medium, yet nothing recorded it");

  const [high] = classifyDriftRows([row("lib/c.ts", 400)], m);
  assert.equal(high.unrecorded, true);

  // Low drift needs no entry: recording every cosmetic touch would drown the manifest.
  const [low] = classifyDriftRows([row("lib/d.ts", 10)], m);
  assert.equal(low.unrecorded, false);
});

test("the block list decides which risks must be recorded", () => {
  // A repo that only blocks high risk does not require medium entries.
  const highOnly = manifest({ autoPushPolicy: { blockOnRisk: ["high"] } });
  assert.equal(classifyDriftRows([row("lib/e.ts", 40)], highOnly)[0].unrecorded, false);
  assert.equal(classifyDriftRows([row("lib/e.ts", 400)], highOnly)[0].unrecorded, true);

  // No policy at all falls back to the documented default (high and medium).
  const none = manifest({ autoPushPolicy: undefined });
  assert.equal(classifyDriftRows([row("lib/f.ts", 40)], none)[0].unrecorded, true);
});

test("driftProblems splits the two lists", () => {
  const m = manifest({ driftedUpstreamFiles: { "lib/old.ts": { risk: "low" } } });
  const problems = driftProblems(classifyDriftRows([
    row("lib/old.ts", 400),   // stale: recorded low, measured high
    row("lib/new.ts", 40),    // unrecorded
    row("lib/fine.ts", 10),   // low and unrecorded: not a problem
  ], manifest({ driftedUpstreamFiles: { "lib/old.ts": { risk: "low" } } })));

  assert.deepEqual(problems.stale.map((entry) => entry.file), ["lib/old.ts"]);
  assert.deepEqual(problems.unrecorded.map((entry) => entry.file), ["lib/new.ts"]);
  assert.equal(m.driftedUpstreamFiles["lib/old.ts"].risk, "low");
});
