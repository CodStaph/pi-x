import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-write-")));
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./[...path]/route");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots");
const { MAX_FILE_WRITE_BYTES } = await jiti.import("../../../lib/file-write");
allowFileRoot(root);

function write(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function request(filePath, body, { type = "write", contentType = "application/json" } = {}) {
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return POST(
    new NextRequest(`http://localhost/api/files/x?type=${type}`, {
      method: "POST",
      headers: { host: "localhost", "content-type": contentType },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: segments }) },
  );
}

test("writes a file in place and reports its new stat", async () => {
  const file = path.join(root, "notes.txt");
  write(file, "before");

  const response = await request(file, { content: "after", baseMtimeMs: fs.statSync(file).mtimeMs });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.equal(result.size, 5);
  assert.equal(typeof result.mtimeMs, "number");

  // The atomic replace must not leave temp files behind.
  const leftovers = fs.readdirSync(root).filter((name) => name.includes(".pi-web-") && name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("refuses to clobber a file changed after the read", async () => {
  const file = path.join(root, "conflict.txt");
  write(file, "original");
  const before = fs.statSync(file).mtimeMs;

  // Simulate an external edit between read and save.
  write(file, "external change");
  // NTFS may give consecutive writes the same timestamp. Make the simulated
  // external edit observably newer without depending on wall-clock timing.
  fs.utimesSync(file, new Date(), new Date(before + 2000));

  const response = await request(file, { content: "my edit", baseMtimeMs: before });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.conflict, true);
  assert.equal(fs.readFileSync(file, "utf8"), "external change");
});

test("rejects oversized content", async () => {
  const file = path.join(root, "big.txt");
  write(file, "small");
  const response = await request(file, { content: "x".repeat(MAX_FILE_WRITE_BYTES + 1) });
  assert.equal(response.status, 413);
  assert.equal(fs.readFileSync(file, "utf8"), "small");
});

test("rejects writes outside the allowed roots", async () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-outside-")));
  try {
    const file = path.join(outside, "secret.txt");
    write(file, "secret");
    const response = await request(file, { content: "changed" });
    assert.equal(response.status, 403);
    assert.equal(fs.readFileSync(file, "utf8"), "secret");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("validates the request body", async () => {
  const file = path.join(root, "validate.txt");
  write(file, "x");

  assert.equal((await request(file, { content: "x", baseMtimeMs: "soon" })).status, 200);
  assert.equal((await request(file, { content: 42 })).status, 400);
  assert.equal((await request(file, { body: "nope" })).status, 400);
  assert.equal(
    (await request(file, { content: "x" }, { contentType: "text/plain" })).status,
    415,
  );
});

test("refuses directories and symlinks", async () => {
  const directory = path.join(root, "folder");
  fs.mkdirSync(directory, { recursive: true });
  assert.equal((await request(directory, { content: "x" })).status, 400);

  const target = path.join(root, "target.txt");
  write(target, "target");
  const link = path.join(root, "link.txt");
  try {
    fs.symlinkSync(target, link);
  } catch {
    return; // Symlinks need privileges on Windows; skip when unavailable.
  }
  const response = await request(link, { content: "via link" });
  assert.equal(response.status, 400);
  assert.equal(fs.readFileSync(target, "utf8"), "target");
});
