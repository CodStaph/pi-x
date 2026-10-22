// Pins lib/composer-send.ts: the submission order the composer relies on, and the
// one invariant a merge has broken before — exactly one send per submission.

import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runComposerSend } = await jiti.import("./composer-send.ts");

/** A context that records every effect in order, so the sequence is testable. */
function harness({ value = "hello", images = [], isStreaming = false, workspaceUnavailable = null, builtinHandled = false, resolved = null, offersBuiltinWhileStreaming = false } = {}) {
  const events = [];
  const sent = [];
  const context = {
    value,
    attachedImages: images,
    isStreaming,
    workspaceUnavailable,
    offersBuiltinWhileStreaming,
    unlockAudio: () => events.push("unlock"),
    runBuiltin: async (message) => {
      events.push(`builtin:${message}`);
      return builtinHandled;
    },
    resolveMessage: async (message) => {
      events.push(`resolve:${message}`);
      return resolved ?? message;
    },
    send: (message, attached) => {
      events.push("send");
      sent.push({ message, images: attached });
    },
    clear: () => events.push("clear"),
  };
  return { context, events, sent };
}

test("an empty submission does nothing at all", async () => {
  for (const value of ["", "   ", "\n"]) {
    const { context, events } = harness({ value });
    assert.equal(await runComposerSend(context), "ignored");
    // Not even the audio unlock: it exists to satisfy autoplay policy on a real send.
    assert.deepEqual(events, []);
  }
});

test("images without text still send", async () => {
  const { context, events, sent } = harness({ value: "  ", images: [{ data: "AAA", mimeType: "image/png" }] });
  assert.equal(await runComposerSend(context), "sent");
  // An empty message still goes past the built-in handler first, exactly as before.
  assert.deepEqual(events, ["unlock", "builtin:", "resolve:", "send", "clear"]);
  assert.equal(sent[0].images.length, 1);
});

test("audio unlocks before any work is awaited", async () => {
  const { context, events } = harness({ value: "/compact", builtinHandled: true });
  await runComposerSend(context);
  assert.deepEqual(events, ["unlock", "builtin:/compact"]);
});

test("a handled built-in stops the submission", async () => {
  const { context, events, sent } = harness({ value: "/compact", builtinHandled: true });
  assert.equal(await runComposerSend(context), "builtin");
  assert.deepEqual(events, ["unlock", "builtin:/compact"]);
  assert.deepEqual(sent, [], "a built-in must not also prompt");
  assert.equal(events.includes("clear"), false);
});

test("while streaming, only the built-ins that opt in may run", async () => {
  // /mcp and /copy are offered while streaming; a handled one wins.
  const handled = harness({ value: "/mcp", isStreaming: true, offersBuiltinWhileStreaming: true, builtinHandled: true });
  assert.equal(await runComposerSend(handled.context), "builtin");

  // Anything else stays in the composer — the queue path owns steer/follow-up.
  const blocked = harness({ value: "keep typing", isStreaming: true, builtinHandled: false });
  assert.equal(await runComposerSend(blocked.context), "blocked");
  // Not even offered to the built-in handler: `builtinAllowed` is false here.
  assert.deepEqual(blocked.events, ["unlock"]);
});

test("a missing workspace blocks before references are resolved", async () => {
  const { context, events } = harness({ value: "hello", workspaceUnavailable: { reason: "gone" } });
  assert.equal(await runComposerSend(context), "blocked");
  assert.deepEqual(events, ["unlock", "builtin:hello"]);
});

test("mentions resolve before sending and the raw text never leaves", async () => {
  const { context, events, sent } = harness({ value: "  see #abc123 ", resolved: "see /path/to/abc123.jsonl" });
  assert.equal(await runComposerSend(context), "sent");
  assert.deepEqual(events, ["unlock", "builtin:see #abc123", "resolve:see #abc123", "send", "clear"]);
  assert.deepEqual(sent, [{ message: "see /path/to/abc123.jsonl", images: undefined }]);
});

test("one submission sends exactly once", async () => {
  const { context, sent } = harness({ value: "hello" });
  await runComposerSend(context);
  assert.equal(sent.length, 1, "a second onSend would restore the text as if it had never been sent");
});

test("send happens before clear, so the composer clears a sent message", async () => {
  const { context, events } = harness({ value: "hello" });
  await runComposerSend(context);
  assert.deepEqual(events.slice(-2), ["send", "clear"]);
});
