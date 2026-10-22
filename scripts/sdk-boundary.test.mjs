// Pins scripts/measure-sdk-boundary.mjs: the measurement rules, the ratchet
// comparison, and — most importantly — that this repository still sits at or
// below its recorded baseline. The last assertion is what makes `drift:sdk` a
// ratchet in `npm test` rather than a script nobody runs.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareMetrics, formatReport, measureSdkBoundary } from "./measure-sdk-boundary.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "pi-sdk-boundary-"));
  for (const [path, source] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

test("counts SDK imports and unsafe assertions in source files only", () => {
  const root = fixtureTree({
    "lib/a.ts": [
      'import type { X } from "@earendil-works/pi-coding-agent";',
      "const value = nil as unknown as X;",
      "const other = value as unknown as X;",
    ].join("\n"),
    "lib/nested/b.tsx": [
      'import { createAgentSession } from "@earendil-works/pi-coding-agent";',
      'import type { Model } from "@earendil-works/pi-ai";',
    ].join("\n"),
    "hooks/c.ts": "export const nothing = 1;\n",
    // A lazy import reaches the SDK just like a static one (it used to be invisible
    // to the ratchet: the export route and the boot warm-up both load it this way).
    "lib/lazy.ts": "export const load = () => import(\"@earendil-works/pi-coding-agent\");\n",
    // Ignored: tests are not part of the boundary, and neither are dependencies
    // or dot-directories.
    "lib/a.test.ts": 'import { y } from "@earendil-works/pi-ai";\n',
    "node_modules/d.ts": 'import { z } from "@earendil-works/pi-ai";\n',
    ".hidden/e.ts": 'import { z } from "@earendil-works/pi-ai";\n',
  });

  try {
    const { metrics, files } = measureSdkBoundary(root);
    assert.deepEqual(metrics, {
      sdkImportFiles: 3,
      sdkImportStatements: 4,
      unsafeAssertions: 2,
    });
    assert.deepEqual(files.map((file) => file.path).sort(), ["lib/a.ts", "lib/lazy.ts", "lib/nested/b.tsx"]);
    // Sorted by weight so the report leads with the worst offender.
    assert.equal(files[0].path, "lib/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty tree measures zero rather than failing", () => {
  const root = fixtureTree({ "lib/empty.ts": "export {};\n" });
  try {
    assert.deepEqual(measureSdkBoundary(root).metrics, {
      sdkImportFiles: 0,
      sdkImportStatements: 0,
      unsafeAssertions: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ratchet allows equal or lower values and rejects growth", () => {
  const baseline = { metrics: { sdkImportFiles: 70, sdkImportStatements: 89, unsafeAssertions: 25 } };

  const same = compareMetrics({ sdkImportFiles: 70, sdkImportStatements: 89, unsafeAssertions: 25 }, baseline);
  assert.deepEqual(same.map((row) => row.ok), [true, true, true]);
  assert.deepEqual(same.map((row) => row.delta), [0, 0, 0]);

  const better = compareMetrics({ sdkImportFiles: 68, sdkImportStatements: 87, unsafeAssertions: 21 }, baseline);
  assert.deepEqual(better.map((row) => row.ok), [true, true, true]);
  assert.deepEqual(better.map((row) => row.delta), [-2, -2, -4]);

  const worse = compareMetrics({ sdkImportFiles: 71, sdkImportStatements: 90, unsafeAssertions: 26 }, baseline);
  assert.deepEqual(worse.map((row) => row.ok), [false, false, false]);
  assert.deepEqual(worse.map((row) => row.delta), [1, 1, 1]);

  // A metric the baseline does not know is not silently accepted.
  const added = compareMetrics({ ...baseline.metrics, newMetric: 3 }, baseline);
  assert.equal(added.find((row) => row.key === "newMetric").ok, false);
  assert.equal(added.find((row) => row.key === "newMetric").baseline, null);
});

test("the report shows the baseline and flags a regression", () => {
  const baseline = { updatedAt: "2026-10-21", metrics: { sdkImportFiles: 70, sdkImportStatements: 89, unsafeAssertions: 25 } };
  const report = formatReport(
    compareMetrics({ sdkImportFiles: 72, sdkImportStatements: 89, unsafeAssertions: 25 }, baseline),
    baseline,
  );
  assert.match(report, /SDK boundary \(baseline 2026-10-21\)/);
  assert.match(report, /sdkImportFiles\s+72\s+\(baseline 70\)\s+\+2\s+REGRESSED/);
  assert.doesNotMatch(report, /sdkImportStatements\s+89\s+\(baseline 89\)\s+\S*\s*REGRESSED/);
});

test("this repository still sits at or below the recorded baseline", () => {
  const baseline = JSON.parse(readFileSync(join(repoRoot, "scripts/sdk-boundary-baseline.json"), "utf8"));
  assert.equal(baseline.schemaVersion, 1);
  assert.match(baseline.updatedAt, /^\d{4}-\d{2}-\d{2}$/);

  const { metrics } = measureSdkBoundary(repoRoot);
  for (const row of compareMetrics(metrics, baseline)) {
    assert.equal(
      row.ok,
      true,
      `${row.key} grew ${row.baseline} -> ${row.current}: route the new SDK access through lib/pi/,`
        + " or raise the baseline deliberately with `npm run drift:sdk -- --update`.",
    );
  }
});
