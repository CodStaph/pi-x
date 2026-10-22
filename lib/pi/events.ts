/**
 * Which agent events the browser handles, and which never reach it.
 *
 * `lib/agent-event-wire.ts` forwards by omission: anything the SDK emits is
 * forwarded unless it is listed here, so a new SDK event reaches the browser
 * automatically — and is silently ignored if `handleAgentEvent()` has no case
 * for it. That failure mode is invisible (no error, no crash, just a feature
 * that stops updating), which is why this module exists:
 *
 *   - `NOT_FORWARDED_EVENTS` says what must not cross the wire, in one place
 *     instead of a private set inside the wire;
 *   - `CLIENT_HANDLED_EVENTS` mirrors the client switch, enforced by
 *     `lib/pi/events.test.mjs`;
 *   - `noteForwardedEventWithoutHandler()` reports the gap the first time an
 *     unlisted event is forwarded (development builds only).
 *
 * Adding a command-less SDK event therefore has two valid answers: handle it in
 * `handleAgentEvent()` and add it here, or list it in `NOT_FORWARDED_EVENTS`.
 * Neither is optional.
 */

/**
 * Events `handleAgentEvent()` switches on (hooks/useAgentSession.ts).
 *
 * `connected`, `prompt_done`, `prompt_error`, `extension_error`,
 * `extension_ui_request`, `extension_ui_closed` and `session_replaced` are
 * pi-web's own events (`CLIENT_SYNTHETIC_EVENTS`); the rest come from the SDK.
 */
export const CLIENT_HANDLED_EVENTS: ReadonlySet<string> = new Set([
  // pi-web synthesis (lib/rpc-manager.ts, lib/agent-event-stream.ts)
  "connected",
  "prompt_done",
  "prompt_error",
  "extension_error",
  "extension_ui_request",
  "extension_ui_closed",
  "session_replaced",
  // SDK: run lifecycle
  "agent_start",
  "agent_end",
  "agent_settled",
  "queue_update",
  // SDK: messages
  "message_start",
  "message_update",
  "message_end",
  // SDK: tools
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  // SDK: automation
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  // SDK: shell and session metadata
  "bash_execution_update",
  "thinking_level_changed",
  "session_info_changed",
  "entry_appended",
]);

/** Events pi-web emits itself; they are absent from the SDK's AgentSessionEvent union. */
export const CLIENT_SYNTHETIC_EVENTS: ReadonlySet<string> = new Set([
  "connected",
  "prompt_done",
  "prompt_error",
  "extension_error",
  "extension_ui_request",
  "extension_ui_closed",
  "session_replaced",
]);

/**
 * Events that never reach the browser.
 *
 * - `turn_start` / `turn_end`: the UI derives turn boundaries from messages.
 * - `session_shutdown`: the SSE stream closes the connection instead.
 *
 * Notably absent: `entry_appended`. It is forwarded as a bare `{ type }` (the
 * entry can be ~1 MiB) because the client refreshes the transcript on it.
 */
export const NOT_FORWARDED_EVENTS: ReadonlySet<string> = new Set([
  "turn_start",
  "turn_end",
  "session_shutdown",
]);

export function isClientHandledEvent(type: string): boolean {
  return CLIENT_HANDLED_EVENTS.has(type);
}

export function isSyntheticClientEvent(type: string): boolean {
  return CLIENT_SYNTHETIC_EVENTS.has(type);
}

/** Whether the wire may forward this event to the browser at all. */
export function isForwardedEvent(type: string): boolean {
  return !NOT_FORWARDED_EVENTS.has(type);
}

const forwardedWithoutHandler = new Map<string, number>();
const warnedTypes = new Set<string>();

/**
 * Count a forwarded event the browser does not handle.
 *
 * Called by the SSE stream for every event it sends. Development builds warn
 * once per event type; the counter keeps working in production so a diagnostic
 * view can report it without spamming the console.
 */
export function noteForwardedEventWithoutHandler(type: string): void {
  if (isClientHandledEvent(type)) return;

  const count = (forwardedWithoutHandler.get(type) ?? 0) + 1;
  forwardedWithoutHandler.set(type, count);

  if (process.env.NODE_ENV === "production") return;
  if (warnedTypes.has(type)) return;
  warnedTypes.add(type);
  console.warn(
    `[pi-web] agent event "${type}" is forwarded to the browser but handleAgentEvent() has no case for it.`
      + " Add a case and list it in CLIENT_HANDLED_EVENTS, or add it to NOT_FORWARDED_EVENTS"
      + " (lib/pi/events.ts) if the browser must not see it.",
  );
}

/** Event types forwarded without a client handler, with how often they were seen. */
export function getForwardedEventsWithoutHandler(): Array<{ type: string; count: number }> {
  return [...forwardedWithoutHandler.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/** Test hook: clear the counters and the warn-once memory. */
export function resetForwardedEventDiagnostics(): void {
  forwardedWithoutHandler.clear();
  warnedTypes.clear();
}
