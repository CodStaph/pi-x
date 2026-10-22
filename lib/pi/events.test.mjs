// Pins the event surface between the SDK, the SSE wire and the client switch.
//
// The wire forwards by omission, so a new SDK event reaches the browser without
// anyone deciding to. These assertions make the two halves — "what crosses the
// wire" and "what the browser handles" — stay in step, and keep the runtime
// diagnostic (noteForwardedEventWithoutHandler) honest.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CLIENT_HANDLED_EVENTS,
  CLIENT_SYNTHETIC_EVENTS,
  NOT_FORWARDED_EVENTS,
  getForwardedEventsWithoutHandler,
  isClientHandledEvent,
  isForwardedEvent,
  noteForwardedEventWithoutHandler,
  resetForwardedEventDiagnostics,
} = await jiti.import("./events.ts");
const { toClientAgentEvent } = await jiti.import("../agent-event-wire.ts");

const hooksSource = readFileSync(new URL("../../hooks/useAgentSession.ts", import.meta.url), "utf8");
const wireSource = readFileSync(new URL("../agent-event-wire.ts", import.meta.url), "utf8");
const streamSource = readFileSync(new URL("../agent-event-stream.ts", import.meta.url), "utf8");
const rpcManagerSource = readFileSync(new URL("../rpc-manager.ts", import.meta.url), "utf8");

/** `case "…"` labels inside handleAgentEvent's switch. */
function clientHandledCases() {
  const start = hooksSource.indexOf("const handleAgentEvent = useCallback((event: AgentEvent) => {");
  assert.notEqual(start, -1, "handleAgentEvent moved; update this guard");
  const end = hooksSource.indexOf("  }, [addNotice, cancelEventStreamGrace", start);
  assert.notEqual(end, -1, "handleAgentEvent's dependency array moved; update this guard");
  const body = hooksSource.slice(start, end);
  return [...body.matchAll(/case "([a-z0-9_]+)":/g)].map((match) => match[1]);
}

test("CLIENT_HANDLED_EVENTS mirrors the client switch exactly", () => {
  const cases = clientHandledCases();
  assert.equal(new Set(cases).size, cases.length, "handleAgentEvent has a duplicate case");
  assert.deepEqual([...CLIENT_HANDLED_EVENTS].sort(), [...cases].sort());
});

test("synthetic events are a labeled subset of the handled events", () => {
  assert.equal(CLIENT_SYNTHETIC_EVENTS.size, 7);
  for (const type of CLIENT_SYNTHETIC_EVENTS) {
    assert.equal(CLIENT_HANDLED_EVENTS.has(type), true, `${type} is not handled by the client`);
  }

  // Everything synthetic has to be emitted by pi-web itself; the SDK cannot
  // send these names.
  for (const type of CLIENT_SYNTHETIC_EVENTS) {
    const emitted = rpcManagerSource.includes(`type: "${type}"`) || streamSource.includes(`type: "${type}"`);
    assert.equal(emitted, true, `${type} is listed as synthetic but nothing emits it`);
  }

  const sdkOnly = [...CLIENT_HANDLED_EVENTS].filter((type) => !CLIENT_SYNTHETIC_EVENTS.has(type));
  for (const type of sdkOnly) {
    assert.equal(
      rpcManagerSource.includes(`type: "${type}"`),
      false,
      `${type} is emitted by pi-web but not listed in CLIENT_SYNTHETIC_EVENTS`,
    );
  }
});

test("nothing is both forwarded and never forwarded", () => {
  for (const type of NOT_FORWARDED_EVENTS) {
    assert.equal(CLIENT_HANDLED_EVENTS.has(type), false, `${type} is dropped by the wire but has a client case`);
    assert.equal(isForwardedEvent(type), false);
  }
  assert.deepEqual([...NOT_FORWARDED_EVENTS].sort(), ["session_shutdown", "turn_end", "turn_start"]);
});

test("entry_appended is forwarded as a bare signal", () => {
  // The entry itself can be ~1 MiB; the browser only refreshes the transcript.
  assert.equal(isForwardedEvent("entry_appended"), true);
  assert.equal(isClientHandledEvent("entry_appended"), true);
  assert.match(hooksSource, /case "entry_appended": \{/);

  const big = { type: "entry_appended", entry: { data: "x".repeat(1024) } };
  assert.deepEqual(toClientAgentEvent(big), { type: "entry_appended" });
});

test("the wire no longer keeps its own omission list", () => {
  assert.doesNotMatch(wireSource, /OMITTED_EVENT_TYPES/);
  assert.match(wireSource, /import \{ isForwardedEvent \} from "\.\/pi\/events";/);
  assert.match(wireSource, /if \(!isForwardedEvent\(event\.type\)\) return null;/);

  assert.deepEqual(toClientAgentEvent({ type: "turn_start" }), null);
  assert.deepEqual(toClientAgentEvent({ type: "turn_end" }), null);
  assert.deepEqual(toClientAgentEvent({ type: "session_shutdown" }), null);
});

test("the SSE stream reports forwarded events the browser does not handle", () => {
  assert.match(streamSource, /noteForwardedEventWithoutHandler\(clientEvent\.type\)/);
});

test("the diagnostic counts once per type and warns once", () => {
  resetForwardedEventDiagnostics();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    noteForwardedEventWithoutHandler("agent_start");
    noteForwardedEventWithoutHandler("message_update");
    assert.deepEqual(getForwardedEventsWithoutHandler(), []);

    noteForwardedEventWithoutHandler("some_new_sdk_event");
    noteForwardedEventWithoutHandler("some_new_sdk_event");
    noteForwardedEventWithoutHandler("another_new_event");

    assert.deepEqual(getForwardedEventsWithoutHandler(), [
      { type: "some_new_sdk_event", count: 2 },
      { type: "another_new_event", count: 1 },
    ]);
    assert.equal(warnings.length, 2, "each unknown event type warns exactly once");
    assert.match(warnings[0], /some_new_sdk_event/);
    assert.match(warnings[0], /CLIENT_HANDLED_EVENTS/);
  } finally {
    console.warn = originalWarn;
    resetForwardedEventDiagnostics();
  }
});

test("production builds count but do not warn", () => {
  resetForwardedEventDiagnostics();
  const warnings = [];
  const originalWarn = console.warn;
  const originalEnv = process.env.NODE_ENV;
  console.warn = (...args) => warnings.push(args.join(" "));
  process.env.NODE_ENV = "production";
  try {
    noteForwardedEventWithoutHandler("some_new_sdk_event");
    noteForwardedEventWithoutHandler("some_new_sdk_event");
    assert.equal(warnings.length, 0);
    assert.deepEqual(getForwardedEventsWithoutHandler(), [{ type: "some_new_sdk_event", count: 2 }]);
  } finally {
    console.warn = originalWarn;
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
    resetForwardedEventDiagnostics();
  }
});
