// Pins lib/pi/entries.ts: the only place SDK or on-disk data becomes this app's
// SessionEntry model, plus the two properties that make that safe — unknown
// entry kinds are never dropped, and malformed JSONL lines never throw.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isSessionEntry,
  parseSessionEntryLines,
  toSessionEntries,
  toSessionEntry,
} = await jiti.import("./entries.ts");

const facadeSource = readFileSync(new URL("./entries.ts", import.meta.url), "utf8");

const userEntry = {
  type: "message",
  id: "e1",
  parentId: null,
  timestamp: "2026-10-21T10:00:00.000Z",
  message: { role: "user", content: "hi" },
};

test("recognizes anything carrying a string type", () => {
  assert.equal(isSessionEntry(userEntry), true);
  assert.equal(isSessionEntry({ type: "compaction", id: "e2", parentId: "e1", summary: "s" }), true);
  // A session header shares type/id/timestamp. Callers skip it themselves
  // (`readSessionRelationEntries` slices the first line) and every consumer
  // switches on `type`, so accepting it keeps the old behaviour exactly.
  assert.equal(isSessionEntry({ type: "session", id: "s1", timestamp: "t", cwd: "/tmp" }), true);
});

test("rejects values that cannot be an entry", () => {
  for (const value of [null, undefined, 42, "message", [], [userEntry], {}, { type: 7 }]) {
    assert.equal(isSessionEntry(value), false);
  }
});

test("toSessionEntry narrows instead of throwing", () => {
  assert.equal(toSessionEntry(userEntry), userEntry);
  assert.equal(toSessionEntry({ nope: true }), null);
  assert.equal(toSessionEntry(null), null);
});

test("toSessionEntries passes every entry through, including unknown kinds", () => {
  const future = { type: "some_future_entry", id: "e9", parentId: "e1", timestamp: "t" };
  const input = [userEntry, future];
  const entries = toSessionEntries(input);

  assert.equal(entries.length, 2);
  assert.equal(entries[0], userEntry);
  // Dropping an entry the mirror does not model yet would silently lose it from
  // readSessionToolSelection, getUsageCostBreakdown and the tree walkers.
  assert.equal(entries[1], future);
});

test("parseSessionEntryLines tolerates anything a live session file contains", () => {
  const lines = [
    JSON.stringify(userEntry),
    "",
    "   ",
    "{ this is not json",
    JSON.stringify(userEntry).slice(0, 20), // torn tail of an append
    "42",
    "null",
    JSON.stringify(["not", "an", "entry"]),
    JSON.stringify({ noType: true }),
    JSON.stringify({ type: "some_future_entry", id: "e9" }),
  ];

  const entries = parseSessionEntryLines(lines);
  assert.deepEqual(entries.map((entry) => entry.type), ["message", "some_future_entry"]);
  assert.equal(entries[0].id, "e1");
});

test("parseSessionEntryLines of nothing is empty", () => {
  assert.deepEqual(parseSessionEntryLines([]), []);
  assert.deepEqual(parseSessionEntryLines([""]), []);
});

test("the facade stays free of SDK imports", () => {
  assert.doesNotMatch(facadeSource, /@earendil-works/);
  assert.match(facadeSource, /import type \{ SessionEntry \} from "\.\.\/types";/);
});

test("no call site casts entries inline anymore", () => {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (path.endsWith(join("pi", "entries.ts"))) continue;
      if (readFileSync(path, "utf8").includes("as unknown as SessionEntry")) {
        offenders.push(path.slice(repoRoot.length).replaceAll(sep, "/"));
      }
    }
  };

  for (const root of ["lib", "app", "hooks", "components"]) walk(join(repoRoot, root));

  assert.deepEqual(offenders, [], "use toSessionEntries()/parseSessionEntryLines() from lib/pi/entries.ts");
});

test("the known readers go through the facade", () => {
  const readers = [
    "../session-reader.ts",
    "../rpc-manager.ts",
    "../subagent-runtime.ts",
    "../mcp-read-only-policy.ts",
    "../../app/api/sessions/[id]/route.ts",
    "../../app/api/sessions/[id]/context/route.ts",
    "../../app/api/sessions/[id]/reference/route.ts",
  ];

  for (const reader of readers) {
    const source = readFileSync(new URL(reader, import.meta.url), "utf8");
    assert.match(
      source,
      /from "(\.\.\/|\.\/)*pi\/entries"|from "@\/lib\/pi\/entries"/,
      `${reader} does not import lib/pi/entries`,
    );
  }

  const sessionReader = readFileSync(new URL("../session-reader.ts", import.meta.url), "utf8");
  assert.match(sessionReader, /export function getSessionEntries\(filePath: string\): SessionEntry\[\] \{[\s\S]*?toSessionEntries\(/);
  assert.doesNotMatch(sessionReader, /function parseSessionEntries\(/);
});
