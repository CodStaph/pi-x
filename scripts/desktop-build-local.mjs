// Build a local, UNSIGNED desktop bundle.
//
// `bundle.createUpdaterArtifacts` in src-tauri/tauri.conf.json makes every
// `tauri build` sign the installer with the updater private key, which only the
// release workflow has. A local build without that key dies with:
//
//   A public key has been found, but no private key. Make sure to set
//   `TAURI_SIGNING_PRIVATE_KEY` environment variable.
//
// This script layers src-tauri/tauri.local.conf.json on top to turn updater
// artifacts off, so the same command produces a normal installer. The result
// cannot self-update — that is exactly what a local build is for. Use the
// release workflow (or `desktop:build` with TAURI_SIGNING_PRIVATE_KEY set) when
// you need a signed, updatable package.
//
// It also drops the packaged server's runtime config that the Pi desktop shell
// exports into its shell (`__NEXT_PRIVATE_STANDALONE_CONFIG` /
// `__NEXT_PRIVATE_ORIGIN`): JSON drops function values, so an inherited
// standalone config breaks the Next.js build with `generate is not a function`.
//
// Usage: npm run desktop:build:local [-- <extra tauri build args>]

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const prepareScript = join(rootDir, "scripts", "prepare-desktop.mjs");
const localConfig = join(rootDir, "src-tauri", "tauri.local.conf.json");

const env = { ...process.env };
delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
delete env.__NEXT_PRIVATE_ORIGIN;

function run(label, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

try {
  console.log("[desktop:build:local] staging the packaged server (desktop:prepare)…");
  await run("desktop:prepare", process.execPath, [prepareScript]);

  console.log("[desktop:build:local] building an unsigned installer (updater artifacts off)…");
  await run("tauri build", process.execPath, [
    tauriCli,
    "build",
    "--config",
    localConfig,
    ...process.argv.slice(2),
  ]);
} catch (error) {
  console.error(`[desktop:build:local] ${error.message}`);
  process.exitCode = 1;
}
