import { NextResponse } from "next/server";
import { AGENT_ERROR_CODES } from "@/lib/agent-error-codes";
import { resolveSessionPath } from "@/lib/session-reader";
import { parseSessionCommand } from "@/lib/pi/session-commands";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    // The contract in lib/pi/session-commands.ts decides what may be dispatched
    // at all. Only shape problems stop here; an empty name or an unknown model
    // is still the wrapper's error to raise.
    const parsed = parseSessionCommand(await req.json());
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, code: AGENT_ERROR_CODES.invalidCommand },
        { status: 400 },
      );
    }
    const command = parsed.command;
    commandType = command.type;
    const { toolNames } = command;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (command.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(command);
      promptAccepted = command.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(command.type === "prompt"
          ? { code: AGENT_ERROR_CODES.promptRejected, accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(command);
    promptAccepted = command.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: AGENT_ERROR_CODES.promptRejected, accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
