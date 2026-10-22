// Pins the stage-B diagnostic surface: the shadow report has to be readable, or
// the "observe a release cycle" exit condition in docs/agents/state-authority.md
// can never be checked.

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route");
const { getPhaseDiagnostics, notePhaseMismatch, resetPhaseDiagnostics } = await jiti.import("@/lib/session/state");

test("reports shadow mode with no mismatches", async () => {
  resetPhaseDiagnostics();
  try {
    const body = await (await GET()).json();
    assert.deepEqual(body, {
      sessionPhase: { mode: "shadow", risky: 0, conservative: 0, sessions: [] },
    });
  } finally {
    resetPhaseDiagnostics();
  }
});

test("reports both directions per session, risky first", async () => {
  resetPhaseDiagnostics();
  try {
    notePhaseMismatch("conservative", "session-a");
    notePhaseMismatch("risky", "session-b");
    notePhaseMismatch("conservative", "session-b");

    const body = await (await GET()).json();
    assert.equal(body.sessionPhase.risky, 1);
    assert.equal(body.sessionPhase.conservative, 2);
    assert.deepEqual(body.sessionPhase.sessions, [
      { sessionId: "session-b", risky: 1, conservative: 1 },
      { sessionId: "session-a", risky: 0, conservative: 1 },
    ]);
    // The endpoint reports, it does not decide: shadow is still shadow.
    assert.equal(body.sessionPhase.mode, "shadow");
  } finally {
    resetPhaseDiagnostics();
  }
});

test("the switch defaults to the flags", async () => {
  // `PI_WEB_SESSION_PHASE` is read once when rpc-manager loads; a test process
  // without it must report shadow, which is what makes the default safe.
  const { AgentSessionWrapper } = await jiti.import("@/lib/rpc-manager");
  assert.equal(AgentSessionWrapper.phaseDrivesRunning(), false);
  assert.deepEqual(getPhaseDiagnostics().sessions, []);
});
