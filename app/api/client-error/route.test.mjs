import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { MAX_CLIENT_ERROR_REPORT_BYTES } = await jiti.import("../../../lib/client-error-report.ts");

function post(body, { raw = false } = {}) {
  return POST(
    new Request("http://localhost/api/client-error", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    }),
  );
}

/** Capture what the route writes to the server log. */
async function capture(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    const response = await run();
    return { response, lines };
  } finally {
    console.error = original;
  }
}

test("logs a client render error and answers ok", async () => {
  const { response, lines } = await capture(() =>
    post({
      boundary: "global",
      message: "Cannot read properties of undefined (reading 'total')",
      digest: "abc123",
      url: "http://127.0.0.1:38472/?session=x",
      userAgent: "test-agent",
      stack: "Error: boom\n    at AppShell",
      at: "2026-10-07T13:56:00.000Z",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const text = lines.join("\n");
  assert.match(text, /client render error \(global\)/);
  assert.match(text, /Cannot read properties of undefined/);
  assert.match(text, /digest: abc123/);
  assert.match(text, /at AppShell/);
});

test("never trusts the client for size: oversized fields are truncated", async () => {
  const { response, lines } = await capture(() =>
    post({ boundary: "app", message: "x".repeat(5_000), stack: "s".repeat(9_000) }),
  );

  assert.equal(response.status, 200);
  const text = lines.join("\n");
  assert.ok(text.length < 12_000, `log stayed bounded (${text.length} bytes)`);
  assert.match(text, /x{10,}…/);
});

test("rejects a report larger than the cap and invalid JSON", async () => {
  const oversized = await capture(() => post("{" + "a".repeat(MAX_CLIENT_ERROR_REPORT_BYTES + 1), { raw: true }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.lines.length, 0);

  const invalid = await capture(() => post("not json", { raw: true }));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.lines.length, 0);
});
