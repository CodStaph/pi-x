import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getFileDraft,
  setFileDraft,
  clearFileDraft,
  clearAllFileDrafts,
} = await jiti.import("./file-draft-cache");

test("stores, updates, and clears a draft by path", () => {
  clearAllFileDrafts();
  assert.equal(getFileDraft("/a.txt"), undefined);

  setFileDraft("/a.txt", "one", 111);
  assert.deepEqual(
    { content: getFileDraft("/a.txt").content, baseMtimeMs: getFileDraft("/a.txt").baseMtimeMs },
    { content: "one", baseMtimeMs: 111 },
  );

  setFileDraft("/a.txt", "two", 222);
  assert.equal(getFileDraft("/a.txt").content, "two");

  clearFileDraft("/a.txt");
  assert.equal(getFileDraft("/a.txt"), undefined);
});

test("evicts the least recently touched draft past the cap", () => {
  clearAllFileDrafts();
  for (let index = 0; index < 21; index++) {
    setFileDraft(`/draft-${index}.txt`, `content ${index}`);
  }
  assert.equal(getFileDraft("/draft-0.txt"), undefined, "the oldest draft must be evicted");
  assert.equal(getFileDraft("/draft-20.txt").content, "content 20");
  clearAllFileDrafts();
});
