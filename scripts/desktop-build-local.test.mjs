import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(root, "scripts", "desktop-build-local.mjs");
const localConfigPath = join(root, "src-tauri", "tauri.local.conf.json");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const localConfig = JSON.parse(await readFile(localConfigPath, "utf8"));
const source = await readFile(scriptPath, "utf8");

test("desktop:build:local is wired to the local build script", () => {
  assert.equal(
    pkg.scripts["desktop:build:local"],
    "node scripts/desktop-build-local.mjs",
  );
});

test("the local Tauri config turns updater artifact signing off", async () => {
  // The base config enables updater artifacts, which makes every build require
  // the updater private key and fails a local one with
  // "A public key has been found, but no private key."
  assert.equal(localConfig.bundle?.createUpdaterArtifacts, false);

  const base = JSON.parse(
    await readFile(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  // The override only helps while the base keeps signing on for releases.
  assert.equal(base.bundle?.createUpdaterArtifacts, true);
});

test("the local build script drops the packaged server env and layers the local config", () => {
  // The Pi desktop shell exports its serialized standalone config, which breaks
  // a fresh Next.js build with `generate is not a function`.
  assert.match(source, /delete env\.__NEXT_PRIVATE_STANDALONE_CONFIG/);
  assert.match(source, /delete env\.__NEXT_PRIVATE_ORIGIN/);

  // `desktop:prepare` must run before `tauri build`, with the local config
  // merged so the bundler skips signing.
  const prepareIndex = source.indexOf("desktop:prepare");
  const buildIndex = source.indexOf('"tauri build"');
  assert.ok(prepareIndex !== -1, "script should run desktop:prepare");
  assert.ok(buildIndex !== -1, "script should run tauri build");
  assert.ok(
    prepareIndex < buildIndex,
    "desktop:prepare must run before tauri build",
  );
  assert.match(source, /tauri\.local\.conf\.json/);
  assert.match(source, /"--config"/);
});
