// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.
//
// The command and its result are both keyed by `lib/pi/session-commands.ts`:
// the type argument is the command's `type`, so a misspelled command name or a
// field the contract does not describe fails at compile time instead of in the
// browser console.

import type { CommandOf, CommandResult, CommandType } from "@/lib/pi/session-commands";
import { AGENT_ERROR_CODES } from "./agent-error-codes";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === AGENT_ERROR_CODES.promptRejected
    && error.accepted === false;
}

export async function sendAgentCommand<T extends CommandType>(
  sessionId: string,
  command: CommandOf<T>,
): Promise<CommandResult<T>> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: CommandResult<T>;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  return body.data as CommandResult<T>;
}
