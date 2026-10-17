import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { scanAllSessions, invalidateScannedSession, extractTextContent } = await jitiImport();
async function jitiImport() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  return await jiti.import("./session-scan");
}

function setTestAgentDir(t, agentDir) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piSessionScanCache = undefined;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    globalThis.__piSessionScanCache = undefined;
  });
}

function writeSession(filePath, { id, cwd = "/tmp/project", name, parentSession, messages = [] }) {
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
      ...(parentSession ? { parentSession } : {}),
    }),
    ...messages.map((message, index) => JSON.stringify({
      type: "message",
      id: `m${index}`,
      parentId: null,
      timestamp: message.timestamp ?? "2026-01-01T00:00:01.000Z",
      message,
    })),
    ...(name ? [JSON.stringify({ type: "session_info", id: "n", parentId: null, timestamp: "2026-01-01T00:00:02.000Z", name })] : []),
  ];
  writeFileSync(filePath, lines.join("\n") + "\n");
}

test("scans sessions with SDK-compatible field semantics (no allMessagesText)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scan-basic-"));
  setTestAgentDir(t, dir);
  mkdirSync(join(dir, "sessions", "proj"), { recursive: true });
  const filePath = join(dir, "sessions", "proj", "a.jsonl");
  writeSession(filePath, {
    id: "scan-a",
    name: "Named session",
    messages: [
      { role: "user", content: "hello world", timestamp: "2026-01-01T00:00:01.000Z" },
      { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: "2026-01-01T00:00:05.000Z" },
    ],
  });

  const sessions = await scanAllSessions();
  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.equal(session.id, "scan-a");
  assert.equal(session.cwd, "/tmp/project");
  assert.equal(session.name, "Named session");
  assert.equal(session.messageCount, 2);
  assert.equal(session.firstMessage, "hello world");
  // modified comes from the last message timestamp, not the file mtime
  assert.equal(session.modified.toISOString(), "2026-01-01T00:00:05.000Z");
  assert.equal("allMessagesText" in session, false);
});

test("unchanged files are served from the mtime+size cache; changes are picked up", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scan-cache-"));
  setTestAgentDir(t, dir);
  mkdirSync(join(dir, "sessions", "proj"), { recursive: true });
  const changedPath = join(dir, "sessions", "proj", "changed.jsonl");
  const unchangedPath = join(dir, "sessions", "proj", "unchanged.jsonl");
  writeSession(changedPath, { id: "scan-changed", messages: [{ role: "user", content: "v1" }] });
  writeSession(unchangedPath, { id: "scan-unchanged", messages: [{ role: "user", content: "stable" }] });

  const first = await scanAllSessions();
  assert.equal(first.length, 2);

  // Append a second message to one file (mtime changes → reparsed),
  // leave the other untouched (mtime+size unchanged → cache hit).
  writeSession(changedPath, {
    id: "scan-changed",
    messages: [
      { role: "user", content: "v1" },
      { role: "user", content: "v2", timestamp: "2026-01-02T00:00:00.000Z" },
    ],
  });

  const second = await scanAllSessions();
  assert.equal(second.length, 2);
  const changed = second.find((s) => s.id === "scan-changed");
  const unchanged = second.find((s) => s.id === "scan-unchanged");
  assert.equal(changed.messageCount, 2);
  assert.equal(changed.firstMessage, "v1");
  assert.equal(unchanged.messageCount, 1);
});

test("invalidateScannedSession forces a reparse even when mtime is restored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scan-invalidate-"));
  setTestAgentDir(t, dir);
  mkdirSync(join(dir, "sessions", "proj"), { recursive: true });
  const filePath = join(dir, "sessions", "proj", "rewritten.jsonl");
  writeSession(filePath, { id: "scan-rewritten", messages: [{ role: "user", content: "before" }] });

  await scanAllSessions();

  // Rewrite in place, then restore the original mtime so the mtime+size key
  // would serve stale cache if invalidation were skipped.
  const statsBefore = await import("node:fs/promises").then((m) => m.stat(filePath));
  writeSession(filePath, { id: "scan-rewritten", messages: [{ role: "user", content: "after" }] });
  utimesSync(filePath, statsBefore.atime, statsBefore.mtime);

  invalidateScannedSession(filePath);
  const sessions = await scanAllSessions();
  assert.equal(sessions[0].firstMessage, "after");
});

test("deleted files drop out of results and the cache; malformed files are skipped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scan-prune-"));
  setTestAgentDir(t, dir);
  mkdirSync(join(dir, "sessions", "proj"), { recursive: true });
  const goodPath = join(dir, "sessions", "proj", "good.jsonl");
  const badPath = join(dir, "sessions", "proj", "bad.jsonl");
  writeSession(goodPath, { id: "scan-good" });
  writeFileSync(badPath, "not a session header\n");
  rmSync(join(dir, "sessions", "proj", "missing.jsonl"), { force: true });

  const first = await scanAllSessions();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "scan-good");

  // The malformed file's null entry is cached, not re-parsed every scan.
  writeFileSync(badPath, "still not a session\n");
  const second = await scanAllSessions();
  assert.equal(second.length, 1);

  rmSync(goodPath);
  const third = await scanAllSessions();
  assert.equal(third.length, 0);
});

test("symlinked project directories are scanned", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-scan-symlink-"));
  const externalDir = mkdtempSync(join(tmpdir(), "pi-scan-symlink-external-"));
  setTestAgentDir(t, dir);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  symlinkSync(externalDir, join(dir, "sessions", "linked-project"), "dir");
  writeFileSync(join(externalDir, "linked.jsonl"), `${JSON.stringify({
    type: "session",
    version: 3,
    id: "scan-linked",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
  })}\n`);
  t.after(() => rmSync(externalDir, { recursive: true, force: true }));

  const sessions = await scanAllSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "scan-linked");
});

test("extractTextContent joins text blocks and ignores non-text content", () => {
  assert.equal(extractTextContent("plain"), "plain");
  assert.equal(
    extractTextContent([
      { type: "text", text: "a" },
      { type: "image", data: "xx" },
      { type: "text", text: "b" },
    ]),
    "a b",
  );
  assert.equal(extractTextContent([{ type: "image", data: "xx" }]), "");
  assert.equal(extractTextContent(undefined), "");
});
