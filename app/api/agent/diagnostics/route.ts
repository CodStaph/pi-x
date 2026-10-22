import { NextResponse } from "next/server";
import { AgentSessionWrapper } from "@/lib/rpc-manager";
import { getPhaseDiagnostics } from "@/lib/session/state";

/**
 * GET /api/agent/diagnostics — the stage-B shadow report.
 *
 * `docs/agents/state-authority.md` says the event-driven phase machine may only
 * answer `isRunning()` once `risky` (flags busy / phase idle) has stayed at 0 for a
 * release cycle. Without a way to read that number the condition can never be
 * checked, which is how a shadow mode becomes permanent. This is the read-only
 * surface for it: how many times the two answers disagreed, in which direction,
 * and for which sessions.
 *
 * Local-only, like every other `/api/**` route: `proxy.ts` gates the request and
 * the payload holds opaque session ids, no message content.
 */
export async function GET() {
  const phase = getPhaseDiagnostics();
  return NextResponse.json({
    sessionPhase: {
      /** "shadow" = the flags answer `isRunning()`; "phase" = the machine does. */
      mode: AgentSessionWrapper.phaseDrivesRunning() ? "phase" : "shadow",
      /** flags busy, phase idle — the direction that would evict a wrapper mid-run. */
      risky: phase.risky,
      /** phase busy, flags idle — conservative, expected around `agent_end`. */
      conservative: phase.conservative,
      sessions: phase.sessions,
    },
  });
}
