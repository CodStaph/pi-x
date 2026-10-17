import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./route");
const { NextRequest } = await jiti.import("next/server");

function browseRequest(directory) {
  const url = directory ? `http://localhost/api/cwd/browse?path=${encodeURIComponent(directory)}` : "http://localhost/api/cwd/browse";
  return new NextRequest(url);
}

test("returns a permission error for a read-denied directory instead of a raw fs error", async (t) => {
  if (process.platform === "win32") return t.skip("chmod does not restrict reads on Windows");
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  const denied = path.join(root, "denied");
  await mkdir(denied);
  await chmod(denied, 0o000);
  try {
    const response = await GET(browseRequest(denied));
    assert.equal(response.status, 403);
    const data = await response.json();
    assert.ok(data.error.includes(denied), `message should name the denied path, got: ${data.error}`);
    assert.match(data.error, /隐私与安全性/);
    assert.doesNotMatch(data.error, /EACCES|EPERM/);
  } finally {
    await chmod(denied, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("lists readable directories with the resolved path and parent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  await mkdir(path.join(root, "project"));
  try {
    const response = await GET(browseRequest(root));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.parentPath, path.dirname(await realpath(root)));
    assert.equal(data.path, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing directories as before", async () => {
  const missing = path.join(tmpdir(), `pi-web-missing-${Date.now()}`);
  const response = await GET(browseRequest(missing));
  assert.equal(response.status, 404);
  const data = await response.json();
  assert.match(data.error, /Directory does not exist/);
});
