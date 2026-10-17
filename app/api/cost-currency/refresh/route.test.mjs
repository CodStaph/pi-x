import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-cost-currency-refresh-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const refreshRoute = await jiti.import("./route");
const settingsRoute = await jiti.import("../route");

const originalFetch = globalThis.fetch;

function post() {
  return refreshRoute.POST(new Request("http://localhost/api/cost-currency/refresh", {
    method: "POST",
    headers: { host: "localhost" },
  }));
}

function stubFetch(handler) {
  globalThis.fetch = handler;
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("fetches and persists a rate, then reports it from the settings route", async () => {
  await settingsRoute.PUT(new Request("http://localhost/api/cost-currency", {
    method: "PUT",
    headers: { host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "CNY", provider: "frankfurter" }),
  }));

  let calledUrl = null;
  stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ date: "2026-10-06", rates: { CNY: 6.7046 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const response = await post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(calledUrl, /api\.frankfurter\.dev/);
  assert.equal(body.rate, 6.7046);
  assert.equal(body.rateDate, "2026-10-06");
  assert.equal(body.rateSource, "frankfurter");
  assert.equal(typeof body.rateUpdatedAt, "number");

  const stored = await (await settingsRoute.GET()).json();
  assert.equal(stored.rate, 6.7046);
});

test("a failed refresh returns 502 and keeps the stored rate", async () => {
  stubFetch(async () => new Response("nope", { status: 503 }));
  const failed = await post();
  assert.equal(failed.status, 502);

  const stored = await (await settingsRoute.GET()).json();
  assert.equal(stored.rate, 6.7046, "the previous successful rate survives");
});

test("refuses an untrusted origin", async () => {
  const response = await refreshRoute.POST(new Request("http://localhost/api/cost-currency/refresh", {
    method: "POST",
    headers: { host: "localhost", origin: "https://evil.example" },
  }));
  assert.equal(response.status, 403);
});
