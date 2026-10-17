import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-localized-output-route-"));
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

const file = path.join(agentDir, "APPEND_SYSTEM.md");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/localized-output", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("reads off, enables with the interface locale, then clears", async () => {
  const initial = await GET();
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { enabled: false, path: file });

  const enabled = await put({ enabled: true, locale: "zh-CN" });
  assert.equal(enabled.status, 200);
  const enabledBody = await enabled.json();
  assert.equal(enabledBody.enabled, true);
  assert.equal(enabledBody.locale, "zh-CN");
  assert.match(await readFile(file, "utf8"), /Simplified Chinese/);

  const off = await put({ enabled: false, locale: "en" });
  assert.deepEqual(await off.json(), { enabled: false, path: file });
  assert.equal(existsSync(file), false);
});

test("rejects a missing/invalid locale, a non-boolean enabled, bad content type and a foreign origin", async () => {
  for (const body of [
    { enabled: true },
    { enabled: true, locale: "fr" },
    { enabled: "yes", locale: "en" },
    { locale: "en" },
    {},
    [],
    "{ not json",
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const plain = await put({ enabled: true, locale: "en" }, { host: "localhost", "Content-Type": "text/plain" });
  assert.equal(plain.status, 415);
  const foreign = await put({ enabled: true, locale: "en" }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" });
  assert.equal(foreign.status, 403);
});

test("preserves unrelated content already in APPEND_SYSTEM.md", async () => {
  await writeFile(file, "# mine\n");
  await put({ enabled: true, locale: "en" });
  let content = await readFile(file, "utf8");
  assert.match(content, /# mine/);
  assert.match(content, /pi-web:localized-output:begin/);

  await put({ enabled: false, locale: "en" });
  content = await readFile(file, "utf8");
  assert.equal(content, "# mine\n");
});
