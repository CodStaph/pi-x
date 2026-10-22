/**
 * The `code` values the agent routes put in an error body, in one place.
 *
 * `POST /api/agent/[id]` and `POST /api/agent/new` both answer
 * `{ error, code? }` on failure, and the browser branches on `code` (not on the
 * message, which is localized prose). Two literals were already duplicated across
 * three files; a typo on either side turns a recoverable answer into a generic
 * error, silently.
 *
 * `accepted` travels with `prompt_rejected` and is part of the same contract:
 * `accepted: false` means the prompt was definitively not taken, so the composer
 * may restore the text. A rejected prompt is the one case where restoring is safe
 * (`lib/agent-client.ts`, `isPromptRejectedError`).
 *
 * Not every `code` in this app belongs here: this file is only the HTTP contract
 * of the agent routes. Models/MCP/import codes are their own vocabularies.
 */

export const AGENT_ERROR_CODES = {
  /** The prompt was not accepted — no session, or preflight refused it. */
  promptRejected: "prompt_rejected",
  /** The body did not match the command contract (`lib/pi/session-commands.ts`). */
  invalidCommand: "invalid_command",
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

const AGENT_ERROR_CODE_VALUES: readonly string[] = Object.values(AGENT_ERROR_CODES);

export function isAgentErrorCode(value: unknown): value is AgentErrorCode {
  return typeof value === "string" && AGENT_ERROR_CODE_VALUES.includes(value);
}

/** The error body shape both agent routes produce. */
export interface AgentErrorBody {
  error: string;
  code?: AgentErrorCode;
  accepted?: false;
}
