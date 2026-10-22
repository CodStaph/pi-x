/**
 * What the composer does when the user submits.
 *
 * Extracted from `components/ChatInput.tsx` (stage C2-5 of
 * docs/architecture-improvement-plan.zh-CN.md) so the order of its effects can be
 * tested without mounting the composer. The rule this keeps honest is the one a
 * merge has broken before: **exactly one send per submission**. A second
 * `onSend` for the same press flipped the running guard, and the text was
 * restored into the composer as if it had never been sent.
 *
 * The order is part of the contract:
 *
 *   1. an empty submission (no text, no images) does nothing — not even the
 *      audio unlock, which exists to satisfy autoplay policy on a real send;
 *   2. audio unlocks before any work is awaited;
 *   3. a built-in command that handled the text stops here: no prompt, no clear;
 *   4. while a run streams, anything the built-ins did not take stays in the
 *      composer (steering goes through the queue path instead);
 *   5. a missing workspace blocks the send without resolving its references;
 *   6. `#session` mentions resolve before the text leaves the composer, and the
 *      raw text is never sent;
 *   7. the send happens once, and only then is the composer cleared.
 */

export interface ComposerSendContext<TImage = unknown> {
  /** Current composer text, untrimmed. */
  value: string;
  attachedImages: readonly TImage[];
  isStreaming: boolean;
  /** Truthy when the selected cwd vanished; the submission cannot be sent. */
  workspaceUnavailable: unknown;
  /** Whether a built-in slash command may run while a run streams (`/mcp`, `/copy`). */
  offersBuiltinWhileStreaming: boolean;
  unlockAudio?(): void;
  /** Run the built-in command; resolves true when it handled the text. */
  runBuiltin(message: string): Promise<boolean>;
  /** Replace `#session` mentions with file paths. */
  resolveMessage(message: string): Promise<string>;
  send(message: string, images?: readonly TImage[]): void;
  clear(): void;
}

export type ComposerSendOutcome = "ignored" | "builtin" | "blocked" | "sent";

export async function runComposerSend<TImage>(
  context: ComposerSendContext<TImage>,
): Promise<ComposerSendOutcome> {
  const message = context.value.trim();
  if (!message && context.attachedImages.length === 0) return "ignored";

  context.unlockAudio?.();

  const builtinAllowed = !context.isStreaming || context.offersBuiltinWhileStreaming;
  if (builtinAllowed && await context.runBuiltin(message)) return "builtin";

  // Streaming: the queue path (`sendQueued`) owns steer/follow-up submissions;
  // whatever reaches here must stay in the composer.
  if (context.isStreaming) return "blocked";
  if (context.workspaceUnavailable) return "blocked";

  const resolved = await context.resolveMessage(message);
  // One send, exactly once, with the images the composer held at submit time.
  context.send(resolved, context.attachedImages.length ? context.attachedImages : undefined);
  context.clear();
  return "sent";
}
