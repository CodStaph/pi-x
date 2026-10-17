import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-cost-currency-route-"));
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
const { GET, PUT } = await jiti.import("./route");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/cost-currency", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("defaults to auto / frankfurter with no rate, and persists mode + provider", async () => {
  const initial = await GET();
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), {
    mode: "auto",
    provider: "frankfurter",
    rate: null,
    rateUpdatedAt: null,
    rateDate: null,
    rateSource: null,
  });

  const saved = await put({ mode: "CNY", provider: "exchangerate" });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.mode, "CNY");
  assert.equal(savedBody.provider, "exchangerate");

  const reread = await GET();
  assert.equal((await reread.json()).provider, "exchangerate");
});

test("rejects invalid fields, empty patches, bad content types and foreign origins", async () => {
  for (const body of [
    { mode: "EUR" },
    { provider: "ecb" },
    {},
    [],
    "{ not json",
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const plain = await put({ mode: "USD" }, { host: "localhost", "Content-Type": "text/plain" });
  assert.equal(plain.status, 415);
  const foreign = await put(
    { mode: "USD" },
    { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" },
  );
  assert.equal(foreign.status, 403);
});
