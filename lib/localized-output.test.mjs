import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  clearLocalizedOutput,
  getAppendSystemPromptPath,
  isLocalizedOutputLocale,
  localizedOutputBlock,
  readLocalizedOutputState,
  writeLocalizedOutput,
} = await jiti.import("./localized-output");

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pi-web-localized-output-"));
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("reads an absent APPEND_SYSTEM.md as off", () => {
  const state = readLocalizedOutputState(dir);
  assert.equal(state.enabled, false);
  assert.equal(state.locale, undefined);
  assert.equal(state.path, path.join(dir, "APPEND_SYSTEM.md"));
});

test("writes the managed block with the locale's language name and keeps other content", async () => {
  const file = getAppendSystemPromptPath(dir);
  await writeFile(file, "# Keep me\n\nuser text\n");
  const written = writeLocalizedOutput("zh-CN", dir);
  assert.equal(written.enabled, true);
  assert.equal(written.locale, "zh-CN");

  const content = await readFile(file, "utf8");
  assert.match(content, /Simplified Chinese/);
  assert.match(content, /# Keep me/);
  assert.equal(readLocalizedOutputState(dir).enabled, true);
  assert.equal(readLocalizedOutputState(dir).locale, "zh-CN");
});

test("replaces the block instead of stacking it and updates the locale", async () => {
  writeLocalizedOutput("en", dir);
  writeLocalizedOutput("zh-TW", dir);
  const content = await readFile(getAppendSystemPromptPath(dir), "utf8");
  assert.equal((content.match(/pi-web:localized-output:begin/g) ?? []).length, 1);
  assert.match(content, /Traditional Chinese/);
  assert.doesNotMatch(content, /Always answer in English/);
  assert.equal(readLocalizedOutputState(dir).locale, "zh-TW");
});

test("clearing removes only the block and deletes a file that held nothing else", async () => {
  const file = getAppendSystemPromptPath(dir);
  writeLocalizedOutput("en", dir);
  assert.deepEqual(clearLocalizedOutput(dir), { enabled: false, path: file });
  assert.equal(existsSync(file), false);

  await writeFile(file, "user text\n");
  writeLocalizedOutput("en", dir);
  clearLocalizedOutput(dir);
  assert.equal(await readFile(file, "utf8"), "user text\n");
});

test("recognizes only the three built-in locales", () => {
  assert.equal(isLocalizedOutputLocale("en"), true);
  assert.equal(isLocalizedOutputLocale("zh-CN"), true);
  assert.equal(isLocalizedOutputLocale("zh-TW"), true);
  assert.equal(isLocalizedOutputLocale("fr"), false);
  assert.equal(isLocalizedOutputLocale(undefined), false);
  assert.equal(isLocalizedOutputLocale(null), false);
});

test("names the target language in English so the model reads it reliably", () => {
  assert.match(localizedOutputBlock("en"), /English/);
  assert.match(localizedOutputBlock("zh-CN"), /简体中文/);
  assert.match(localizedOutputBlock("zh-TW"), /繁體中文/);
});
