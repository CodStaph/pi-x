/**
 * The command contract between the browser and `POST /api/agent/[id]`.
 *
 * This is the single place that spells out, for one session command:
 *
 *   - the name (`SessionCommand["type"]`),
 *   - the request shape (`SessionCommand`),
 *   - what the HTTP layer answers (`CommandResultMap`),
 *   - the dispatch flags `AgentSessionWrapper.send()` consults (`COMMAND_META`).
 *
 * Adding a command means editing all four; the compiler refuses the ones that
 * are `Record<CommandType, …>` (a missing entry is a type error) and
 * `session-commands.test.mjs` pins the rest.
 *
 * Deliberately no `@earendil-works/*` imports: the client consumes these types,
 * and the SDK boundary belongs in `lib/pi-types.ts` / `lib/rpc-manager.ts`.
 */

import type {
  AgentMessage,
  CacheWarmingInfo,
  ExtensionStatusItem,
  ExtensionWidgetItem,
  RoutedModelInfo,
} from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { ToolEntry } from "@/lib/tool-presets";

/** An attached image, base64 encoded, as the composer sends it. */
export interface AgentImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** How a prompt behaves while the agent is already running. */
export type StreamingBehavior = "steer" | "followUp";

/** pi's queued-message delivery mode. */
export type QueueMode = "all" | "one-at-a-time";

/** One slash command the composer can offer (extension, prompt template or skill). */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export interface SlashCommandsResponse {
  commands?: SlashCommandInfo[];
}

/** What the browser reads from `get_state`; the server sends more fields than the UI uses. */
export interface AgentStateResponse {
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  /** In-memory partial assistant message, present while a run is streaming. */
  streamingMessage?: AgentMessage;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  routedModel?: RoutedModelInfo;
  cacheWarming?: CacheWarmingInfo;
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
  steeringMode?: string;
  followUpMode?: string;
}

export interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export interface LastAssistantTextResponse {
  text?: string;
}

export interface ForkCommandResult {
  cancelled?: boolean;
  newSessionId?: string;
}

export interface NavigateTreeCommandResult {
  cancelled?: boolean;
  /** `summarize: true` was withdrawn by `abort_branch_summary`. */
  aborted?: boolean;
}

export interface ClearQueueCommandResult {
  steering?: string[];
  followUp?: string[];
}

export interface SetToolsCommandResult {
  sessionId?: string;
  recreated?: boolean;
}

/** `bash` answers with the SDK's execution result; the browser ignores it. */
export type BashCommandResult = unknown;

/**
 * A tool-selection pin that may ride along on any command when a dormant
 * session is resumed (the route passes it to `startRpcSession()`).
 */
type ResumeToolPin = { toolNames?: string[] };

/**
 * Every command the HTTP route dispatches to an AgentSession.
 *
 * Shapes describe what the client sends today — the SDK call sites narrow the
 * same fields again in `AgentSessionWrapper.send()`.
 */
export type SessionCommand = ResumeToolPin & (
  // run lifecycle
  | { type: "prompt"; message: string; images?: AgentImage[]; streamingBehavior?: StreamingBehavior }
  | { type: "steer"; message: string; images?: AgentImage[] }
  | { type: "follow_up"; message: string; images?: AgentImage[] }
  | { type: "abort" }
  | { type: "abort_retry" }
  | { type: "abort_compaction" }
  | { type: "clear_queue" }
  | { type: "compact"; customInstructions?: string }
  // reads
  | { type: "get_state" }
  | { type: "get_tools" }
  | { type: "get_commands" }
  | { type: "get_session_stats" }
  | { type: "get_last_assistant_text" }
  // model / thinking / tools
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_tools"; toolNames?: string[] }
  // session identity and tree
  | { type: "set_session_name"; name: string }
  | { type: "fork"; entryId: string }
  | { type: "fork_branch"; entryId: string }
  | { type: "clone"; leafId?: string | null }
  | { type: "navigate_tree"; targetId: string; summarize?: boolean; customInstructions?: string }
  | { type: "abort_branch_summary" }
  // automation
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "set_steering_mode"; mode: QueueMode }
  | { type: "set_follow_up_mode"; mode: QueueMode }
  // extensions
  | { type: "reload" }
  | ({ type: "extension_ui_response" } & (
      | { id: string; value: string }
      | { id: string; confirmed: boolean }
      | { id: string; cancelled: true }
    ))
  | { type: "extension_ui_input"; id: string; data: string }
  // shell
  | { type: "bash"; command: string; excludeFromContext?: boolean }
  | { type: "abort_bash" }
);

export type CommandType = SessionCommand["type"];
export type CommandOf<T extends CommandType> = Extract<SessionCommand, { type: T }>;

/**
 * What the browser receives for each command.
 *
 * This is the *HTTP* contract, not the wrapper's return values: `set_tools`
 * answers `{ sessionId, recreated }` because the route rebuilds the session
 * through `setRpcSessionTools()` instead of forwarding the command, while
 * `AgentSessionWrapper.send()` answers `null` for the same name.
 */
export interface CommandResultMap {
  prompt: null;
  steer: null;
  follow_up: null;
  abort: null;
  abort_retry: null;
  abort_compaction: null;
  clear_queue: ClearQueueCommandResult;
  compact: CompactCommandResult;
  get_state: AgentStateResponse;
  get_tools: ToolEntry[];
  get_commands: SlashCommandsResponse;
  get_session_stats: SessionStatsInfo;
  get_last_assistant_text: LastAssistantTextResponse;
  set_model: { id: string; provider: string };
  set_thinking_level: null;
  set_tools: SetToolsCommandResult;
  set_session_name: null;
  fork: ForkCommandResult;
  fork_branch: ForkCommandResult;
  clone: ForkCommandResult;
  navigate_tree: NavigateTreeCommandResult;
  abort_branch_summary: null;
  set_auto_compaction: null;
  set_auto_retry: null;
  set_steering_mode: null;
  set_follow_up_mode: null;
  reload: { success?: boolean };
  extension_ui_response: null;
  extension_ui_input: null;
  bash: BashCommandResult;
  abort_bash: null;
}

export type CommandResult<T extends CommandType> = CommandResultMap[T];

/**
 * How `AgentSessionWrapper.send()` treats a command.
 *
 * These flags used to live in three hand-maintained sets inside
 * `lib/rpc-manager.ts`; a new command that forgot one silently skipped its
 * guard. Typing the table as `Record<CommandType, CommandMeta>` makes a missing
 * entry a compile error.
 */
export interface CommandMeta {
  /** May run while another session command is in flight (status reads and UI replies). */
  allowedDuringReplacement?: true;
  /** Replaces the session: refused while another mutating command is running. */
  replacesSession?: true;
  /** Waits for extensions that are still loading before it is dispatched. */
  waitsForExtensions?: true;
}

export const COMMAND_META: Record<CommandType, CommandMeta> = {
  prompt: { waitsForExtensions: true },
  steer: { waitsForExtensions: true },
  follow_up: { waitsForExtensions: true },
  abort: {},
  abort_retry: {},
  abort_compaction: {},
  clear_queue: {},
  compact: {},
  get_state: { allowedDuringReplacement: true, waitsForExtensions: true },
  get_tools: { allowedDuringReplacement: true },
  get_commands: { allowedDuringReplacement: true, waitsForExtensions: true },
  get_session_stats: { allowedDuringReplacement: true },
  get_last_assistant_text: { allowedDuringReplacement: true },
  set_model: {},
  set_thinking_level: {},
  set_tools: {},
  set_session_name: {},
  fork: { replacesSession: true },
  fork_branch: {},
  clone: { replacesSession: true },
  navigate_tree: {},
  abort_branch_summary: {},
  set_auto_compaction: {},
  set_auto_retry: {},
  set_steering_mode: {},
  set_follow_up_mode: {},
  reload: {},
  extension_ui_response: { allowedDuringReplacement: true },
  extension_ui_input: { allowedDuringReplacement: true },
  bash: {},
  abort_bash: {},
};

export const COMMAND_TYPES = Object.keys(COMMAND_META) as CommandType[];

/** Command types carrying `flag`, derived from `COMMAND_META` (never listed twice). */
export function commandTypesWith<K extends keyof CommandMeta>(flag: K): ReadonlySet<CommandType> {
  return new Set(COMMAND_TYPES.filter((type) => COMMAND_META[type][flag] === true));
}

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(COMMAND_META, value);
}

export type SessionCommandParseResult =
  | { ok: true; command: SessionCommand }
  | { ok: false; error: string };

function fail(error: string): SessionCommandParseResult {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function imagesProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  for (const image of value) {
    if (!isRecord(image)) return "images must contain objects";
    if (image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") {
      return "each image needs { type: \"image\", data, mimeType }";
    }
  }
  return null;
}

/**
 * Validate a request body before anything is dispatched.
 *
 * Only *type* checks live here: empty strings, unknown models and a missing
 * entry id stay the wrapper's business, so their existing error paths and
 * status codes are unchanged. A shape the contract does not describe is the
 * one case the route can reject without consulting a session.
 */
export function parseSessionCommand(body: unknown): SessionCommandParseResult {
  if (!isRecord(body)) return fail("Command must be an object");
  const { type } = body;
  if (!isCommandType(type)) {
    return fail(`Unsupported command: ${String(type)}`);
  }

  // `toolNames` rides along on every command when a caller resumes a session
  // with a pinned preset, so it is checked for all of them, not just set_tools.
  if (body.toolNames !== undefined && !isStringArray(body.toolNames)) {
    return fail("toolNames must be an array of strings");
  }

  switch (type) {
    case "prompt":
    case "steer":
    case "follow_up": {
      if (typeof body.message !== "string") return fail(`${type}: message must be a string`);
      const problem = imagesProblem(body.images);
      if (problem) return fail(`${type}: ${problem}`);
      if (
        body.streamingBehavior !== undefined
        && body.streamingBehavior !== "steer"
        && body.streamingBehavior !== "followUp"
      ) {
        return fail('prompt: streamingBehavior must be "steer" or "followUp"');
      }
      break;
    }
    case "compact": {
      if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") {
        return fail("compact: customInstructions must be a string");
      }
      break;
    }
    case "set_model": {
      if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
        return fail("set_model: provider and modelId must be strings");
      }
      break;
    }
    case "set_thinking_level": {
      if (typeof body.level !== "string") return fail("set_thinking_level: level must be a string");
      break;
    }
    case "set_tools": {
      if (body.toolNames !== undefined && !isStringArray(body.toolNames)) {
        return fail("set_tools: toolNames must be an array of strings");
      }
      break;
    }
    case "set_session_name": {
      if (typeof body.name !== "string") return fail("set_session_name: name must be a string");
      break;
    }
    case "fork":
    case "fork_branch": {
      if (typeof body.entryId !== "string") return fail(`${type}: entryId must be a string`);
      break;
    }
    case "clone": {
      if (body.leafId !== undefined && body.leafId !== null && typeof body.leafId !== "string") {
        return fail("clone: leafId must be a string or null");
      }
      break;
    }
    case "navigate_tree": {
      if (typeof body.targetId !== "string") return fail("navigate_tree: targetId must be a string");
      if (body.summarize !== undefined && typeof body.summarize !== "boolean") {
        return fail("navigate_tree: summarize must be a boolean");
      }
      if (body.customInstructions !== undefined && typeof body.customInstructions !== "string") {
        return fail("navigate_tree: customInstructions must be a string");
      }
      break;
    }
    case "set_auto_compaction":
    case "set_auto_retry": {
      if (typeof body.enabled !== "boolean") return fail(`${type}: enabled must be a boolean`);
      break;
    }
    case "set_steering_mode":
    case "set_follow_up_mode": {
      if (body.mode !== "all" && body.mode !== "one-at-a-time") {
        return fail(`${type}: mode must be "all" or "one-at-a-time"`);
      }
      break;
    }
    case "extension_ui_response": {
      if (typeof body.id !== "string") return fail("extension_ui_response: id must be a string");
      const hasValue = typeof body.value === "string";
      const hasConfirmed = typeof body.confirmed === "boolean";
      const hasCancelled = body.cancelled === true;
      if (!hasValue && !hasConfirmed && !hasCancelled) {
        return fail("extension_ui_response: needs value, confirmed or cancelled");
      }
      break;
    }
    case "extension_ui_input": {
      if (typeof body.id !== "string" || typeof body.data !== "string") {
        return fail("extension_ui_input: id and data must be strings");
      }
      break;
    }
    case "bash": {
      if (typeof body.command !== "string") return fail("bash: command must be a string");
      if (body.excludeFromContext !== undefined && typeof body.excludeFromContext !== "boolean") {
        return fail("bash: excludeFromContext must be a boolean");
      }
      break;
    }
    // No payload: abort, abort_retry, abort_compaction, clear_queue, get_state,
    // get_tools, get_commands, get_session_stats, get_last_assistant_text,
    // reload, abort_branch_summary, abort_bash. Anything else in the body is
    // ignored, exactly as the wrapper ignores it.
    default:
      break;
  }

  return { ok: true, command: body as SessionCommand };
}
