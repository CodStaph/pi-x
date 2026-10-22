// Pins scripts/check-ownership-sentinels.mjs: the rules that keep the measured
// manifest and the hand-written merge sentinels in step, plus the real repository
// (a high-risk file without a sentinel must fail here, not in a bad merge).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkOwnershipSentinels, readManifest, readSentinels } from "./check-ownership-sentinels.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function fixture({ files = {}, manifest, sentinels = "" }) {
  const root = mkdtempSync(join(tmpdir(), "pi-ownership-"));
  for (const path of Object.keys(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, files[path]);
  }
  mkdirSync(join(root, "components"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  const sentinelsPath = join(root, "test/merge-guards/fork-extractions.test.mjs");
  mkdirSync(dirname(sentinelsPath), { recursive: true });
  writeFileSync(sentinelsPath, sentinels);
  writeFileSync(join(root, "scripts/fork-ownership.json"), JSON.stringify(manifest));
  return root;
}

function problemsFor(options) {
  const root = fixture(options);
  try {
    return checkOwnershipSentinels({
      rootDir: root,
      manifest: JSON.parse(JSON.stringify(options.manifest)),
      sentinels: readSentinels(root),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a covered high-risk file passes", () => {
  const problems = problemsFor({
    files: { "components/A.tsx": "x", "components/Target.tsx": "x" },
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high" } } },
    sentinels: 'const FORK_FEATURES = [{ name: "a", file: "components/A.tsx", markers: [] }];',
  });
  assert.deepEqual(problems, []);
});

test("a high-risk file without a sentinel fails", () => {
  const problems = problemsFor({
    files: { "components/A.tsx": "x" },
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high" } } },
    sentinels: "",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /components\/A\.tsx is high risk but has no sentinel/);
  assert.match(problems[0], /"sentinels": "none"/);
});

test("opting out works, but needs a reason and must not also be covered", () => {
  const base = { files: { "components/A.tsx": "x" } };

  const withReason = problemsFor({
    ...base,
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high", sentinels: "none", sentinelReason: "pure i18n strings" } } },
    sentinels: "",
  });
  assert.deepEqual(withReason, []);

  const withoutReason = problemsFor({
    ...base,
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high", sentinels: "none" } } },
    sentinels: "",
  });
  assert.equal(withoutReason.length, 1);
  assert.match(withoutReason[0], /without a `sentinelReason`/);

  const both = problemsFor({
    ...base,
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high", sentinels: "none", sentinelReason: "x" } } },
    sentinels: 'const FORK_FEATURES = [{ name: "a", file: "components/A.tsx", markers: [] }];',
  });
  assert.equal(both.length, 1);
  assert.match(both[0], /declares .*"sentinels": "none".* but a sentinel covers it/);

  // "elsewhere" is the honest exemption for a file guarded by its own suite.
  const elsewhere = problemsFor({
    ...base,
    manifest: {
      driftedUpstreamFiles: {
        "components/A.tsx": { risk: "high", sentinels: "elsewhere", sentinelReason: "components/A.test.mjs" },
      },
    },
    sentinels: "",
  });
  assert.deepEqual(elsewhere, []);

  const elsewhereWithoutReason = problemsFor({
    ...base,
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high", sentinels: "elsewhere" } } },
    sentinels: "",
  });
  assert.equal(elsewhereWithoutReason.length, 1);
  assert.match(elsewhereWithoutReason[0], /without a `sentinelReason`/);

  // An unknown value is not an exemption.
  const unknown = problemsFor({
    ...base,
    manifest: { driftedUpstreamFiles: { "components/A.tsx": { risk: "high", sentinels: "later", sentinelReason: "x" } } },
    sentinels: "",
  });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0], /is high risk but has no sentinel/);
});

test("a manifest entry whose file disappeared fails", () => {
  const problems = problemsFor({
    files: {},
    manifest: { driftedUpstreamFiles: { "components/Gone.tsx": { risk: "low" } } },
    sentinels: "",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /components\/Gone\.tsx is in the manifest .* but no longer exists/);
});

test("an extraction origin must be a manifest entry", () => {
  const problems = problemsFor({
    files: { "components/Origin.tsx": "x", "components/Moved.tsx": "x" },
    manifest: { driftedUpstreamFiles: {} },
    sentinels: `const EXTRACTIONS = [{
      name: "moved",
      origin: "components/Origin.tsx",
      movedTo: ["components/Moved.tsx"],
      movedDefinitions: [],
      absentFromOrigin: [],
      requiredInOrigin: [],
    }];`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /protects components\/Origin\.tsx, which is not in the manifest/);
});

test("a movedTo target must exist", () => {
  const problems = problemsFor({
    files: { "components/Origin.tsx": "x" },
    manifest: { driftedUpstreamFiles: { "components/Origin.tsx": { risk: "high" } } },
    sentinels: `const EXTRACTIONS = [{
      name: "moved",
      origin: "components/Origin.tsx",
      movedTo: ["components/Missing.tsx"],
      movedDefinitions: [],
      absentFromOrigin: [],
      requiredInOrigin: [],
    }];`,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /code moved to components\/Missing\.tsx, which does not exist/);
});

test("this repository agrees: manifest and sentinels are in step", () => {
  const problems = checkOwnershipSentinels({
    rootDir: repoRoot,
    manifest: readManifest(repoRoot),
  });
  assert.deepEqual(problems, []);
});
