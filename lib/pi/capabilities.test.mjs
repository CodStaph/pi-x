// Pins lib/pi/capabilities.ts: the SDK-version adaptation lives here and nowhere
// else, and every missing capability degrades to the pre-0.86 behaviour instead
// of an error the user sees.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  abortBranchSummary,
  abortRetry,
  detectSessionCapabilities,
  hasBindExtensions,
  replayStateSystemPrompt,
  sdkReportsBusy,
  setFollowUpMode,
  setSteeringMode,
} = await jiti.import("./capabilities.ts");

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readRepoFile(relative) {
  return readFileSync(join(repoRoot, relative), "utf8");
}

/**
 * Comments describe the same SDK behaviour the guards look for ("it can no longer
 * be assigned", "setThinkingLevel clamps to getAvailableThinkingLevels()"), so
 * the runtime guards read code without them.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Recursively collect repo sources, skipping tests and the capability module itself. */
function nonTestSources({ skipCapabilities = true } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (skipCapabilities && path.endsWith(join("pi", "capabilities.ts"))) continue;
      const source = readFileSync(path, "utf8");
      files.push({
        path: path.slice(repoRoot.length).replaceAll(sep, "/"),
        source,
        code: stripComments(source),
      });
    }
  };
  for (const root of ["lib", "app", "hooks", "components"]) walk(join(repoRoot, root));
  return files;
}

test("detects what the session object actually exposes", () => {
  const bare = detectSessionCapabilities({});
  assert.deepEqual(bare, {
    idleFlag: false,
    abortRetry: false,
    abortsBranchSummary: false,
    steeringModes: false,
    followUpModes: false,
    rebindableExtensions: false,
  });

  const full = detectSessionCapabilities({
    isIdle: true,
    abortRetry() {},
    abortBranchSummary() {},
    setSteeringMode() {},
    setFollowUpMode() {},
    bindExtensions() {},
  });
  assert.deepEqual(full, {
    idleFlag: true,
    abortRetry: true,
    abortsBranchSummary: true,
    steeringModes: true,
    followUpModes: true,
    rebindableExtensions: true,
  });

  // The flag's presence is what matters; an undefined reading still means the
  // SDK reports it (sdkReportsBusy then answers false either way).
  const idleOnly = detectSessionCapabilities({ isIdle: undefined });
  assert.equal(idleOnly.idleFlag, true);
  assert.equal(idleOnly.abortRetry, false);
});

test("optional calls report whether they ran instead of throwing", () => {
  const calls = [];
  const session = {
    abortRetry: () => calls.push("retry"),
    abortBranchSummary: () => calls.push("summary"),
    setSteeringMode: (mode) => calls.push(`steer:${mode}`),
    setFollowUpMode: (mode) => calls.push(`follow:${mode}`),
    bindExtensions() {},
  };

  assert.equal(abortRetry(session), true);
  assert.equal(abortBranchSummary(session), true);
  assert.equal(setSteeringMode(session, "one-at-a-time"), true);
  assert.equal(setFollowUpMode(session, "all"), true);
  assert.equal(hasBindExtensions(session), true);
  assert.deepEqual(calls, ["retry", "summary", "steer:one-at-a-time", "follow:all"]);

  // Bare sessions: every helper is a silent no-op, which is what the old `?.()`
  // call sites did. A missing capability must never surface as an error.
  const empty = {};
  assert.equal(abortRetry(empty), false);
  assert.equal(abortBranchSummary(empty), false);
  assert.equal(setSteeringMode(empty, "all"), false);
  assert.equal(setFollowUpMode(empty, "all"), false);
  assert.equal(hasBindExtensions(empty), false);
});

test("sdkReportsBusy only trusts isIdle when the SDK reports it", () => {
  const withFlag = detectSessionCapabilities({ isIdle: true });
  assert.equal(sdkReportsBusy({ isIdle: false }, withFlag), true);
  assert.equal(sdkReportsBusy({ isIdle: true }, withFlag), false);
  assert.equal(sdkReportsBusy({ isIdle: undefined }, withFlag), false);

  const withoutFlag = detectSessionCapabilities({});
  assert.equal(sdkReportsBusy({ isIdle: false }, withoutFlag), false);
});

test("the state prompt is read, never written", () => {
  assert.equal(replayStateSystemPrompt({ agent: { state: { systemPrompt: "prompt" } } }), "prompt");
  assert.equal(replayStateSystemPrompt({ agent: { state: {} } }), undefined);
  assert.equal(replayStateSystemPrompt({ agent: {} }), undefined);

  for (const { path, source } of nonTestSources()) {
    assert.doesNotMatch(
      source,
      /(agent\.state|state)\\?\??\.systemPrompt\s*=[^=]/,
      `${path} assigns state.systemPrompt, which throws since pi 0.86`,
    );
  }
});

test("the adaptation lives in this module only", () => {
  const forbidden = [
    [/isIdle === false/, "asks the SDK about isIdle outside the capability module"],
    [/abortRetry\?\.\(/, "calls abortRetry optionally outside the capability module"],
    [/abortBranchSummary\?\.\(/, "calls abortBranchSummary optionally outside the capability module"],
    [/setSteeringMode\?\.\(/, "calls setSteeringMode optionally outside the capability module"],
    [/setFollowUpMode\?\.\(/, "calls setFollowUpMode optionally outside the capability module"],
    [/typeof [\w.?]*bindExtensions/, "probes bindExtensions outside the capability module"],
    [/agent\.state\??\.systemPrompt/, "reads state.systemPrompt outside the capability module"],
  ];

  for (const { path, code } of nonTestSources()) {
    for (const [pattern, message] of forbidden) {
      assert.doesNotMatch(code, pattern, `${path}: ${message}`);
    }
  }
});

test("the wrapper consumes the capability module", () => {
  const rpcManager = readRepoFile("lib/rpc-manager.ts");
  assert.match(rpcManager, /import \{[^}]*detectSessionCapabilities[^}]*\} from "\.\/pi\/capabilities";/);
  assert.match(rpcManager, /this\.capabilities = detectSessionCapabilities\(inner\);/);
  assert.match(rpcManager, /sdkReportsBusy\(this\.inner, this\.capabilities\)/);
  assert.match(rpcManager, /abortRetry\(this\.inner\)/);
  assert.match(rpcManager, /abortBranchSummary\(this\.inner\)/);
  assert.match(rpcManager, /setSteeringMode\(this\.inner, command\.mode\)/);
  assert.match(rpcManager, /setFollowUpMode\(this\.inner, command\.mode\)/);
  assert.match(rpcManager, /hasBindExtensions\(this\.inner\)/);
  assert.match(rpcManager, /replayStateSystemPrompt\(this\.inner\)/);
});

test("thinking levels are left to the SDK", () => {
  // pi >= 0.86 clamps setThinkingLevel() to the levels the model supports. A
  // manual clamp was removed for that reason; the SDK getter stays unused.
  for (const { path, code } of nonTestSources()) {
    if (path.endsWith("lib/pi-types.ts")) continue;
    assert.doesNotMatch(
      code,
      /getAvailableThinkingLevels\(/,
      `${path} clamps thinking levels by hand; setThinkingLevel already does`,
    );
  }
});

test("the legacy compaction event names stay gone", () => {
  for (const { path, code } of nonTestSources()) {
    assert.doesNotMatch(
      code,
      /auto_compaction_(start|end)/,
      `${path} reintroduced a pre-0.86 compaction event name`,
    );
  }
});
