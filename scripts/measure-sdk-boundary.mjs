#!/usr/bin/env node
/**
 * Ratchet for the SDK boundary (docs/architecture-improvement-plan.zh-CN.md, stage A5).
 *
 * Stages A1-A4 moved the SDK's surface behind `lib/pi/`: one command contract,
 * one event table, one entry conversion, one capability probe. That work only
 * holds if new call sites do not quietly go back to importing the SDK directly,
 * which is exactly what happened before — 70 files imported it and nothing
 * noticed when a 71st appeared.
 *
 * Three numbers are measured over app/ components/ hooks/ lib/ (source only,
 * tests excluded) and compared with `scripts/sdk-boundary-baseline.json`:
 *
 *   sdkImportFiles       files importing @earendil-works/* directly
 *   sdkImportStatements  the individual `from "@earendil-works/*"` specifiers
 *   unsafeAssertions     `as unknown as` occurrences (the casts the facade removes)
 *
 * Every metric is a ratchet: the baseline may only go down. Raising it is a
 * deliberate act, recorded in the baseline file and the commit message.
 *
 * Usage:
 *   node scripts/measure-sdk-boundary.mjs            # check (exit 1 on regression)
 *   node scripts/measure-sdk-boundary.mjs --json     # print the measurement only
 *   node scripts/measure-sdk-boundary.mjs --update   # rewrite the baseline
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_FILE = "scripts/sdk-boundary-baseline.json";
const SOURCE_ROOTS = ["lib", "hooks", "components", "app"];
const SOURCE_FILE = /\.(ts|tsx)$/;
const SDK_IMPORT = /from\s+"@earendil-works\/[^"]+"/g;
const UNSAFE_ASSERTION = /as unknown as/g;

function toPosix(path) {
  return path.split("\\").join("/");
}

function walk(dir, out) {
  // A source root may be absent in a fixture tree (and in a trimmed checkout).
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(path, out);
      continue;
    }
    if (SOURCE_FILE.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) out.push(path);
  }
}

/**
 * Measure the boundary below `rootDir`.
 *
 * Exported for `scripts/sdk-boundary.test.mjs`, which runs it against a fixture
 * tree — the numbers here are the ratchet's whole contract.
 */
export function measureSdkBoundary(rootDir = ROOT) {
  const paths = [];
  for (const name of SOURCE_ROOTS) walk(join(rootDir, name), paths);

  const files = [];
  const metrics = { sdkImportFiles: 0, sdkImportStatements: 0, unsafeAssertions: 0 };

  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    const statements = (source.match(SDK_IMPORT) ?? []).length;
    const assertions = (source.match(UNSAFE_ASSERTION) ?? []).length;
    if (statements > 0) metrics.sdkImportFiles += 1;
    metrics.sdkImportStatements += statements;
    metrics.unsafeAssertions += assertions;

    if (statements > 0 || assertions > 0) {
      files.push({
        path: toPosix(relative(rootDir, path)),
        statements,
        assertions,
      });
    }
  }

  files.sort((a, b) => (b.statements + b.assertions) - (a.statements + a.assertions) || a.path.localeCompare(b.path));
  return { metrics, files };
}

/** Compare each measured metric with the baseline; `ok` is false on growth. */
export function compareMetrics(current, baseline) {
  return Object.keys(current).map((key) => {
    const before = typeof baseline?.metrics?.[key] === "number" ? baseline.metrics[key] : null;
    const after = current[key];
    return {
      key,
      current: after,
      baseline: before,
      delta: before === null ? null : after - before,
      ok: before === null ? false : after <= before,
    };
  });
}

/** Human-readable report; `--update` writes the same numbers back. */
export function formatReport(rows, baseline) {
  const width = Math.max(...rows.map((row) => row.key.length));
  const lines = [
    `SDK boundary (baseline ${baseline?.updatedAt ?? "missing"})`,
  ];
  for (const row of rows) {
    const name = row.key.padEnd(width);
    const before = row.baseline === null ? "(none)" : String(row.baseline);
    const delta = row.delta === null ? "" : row.delta === 0 ? "" : `  ${row.delta > 0 ? "+" : ""}${row.delta}`;
    lines.push(`  ${name}  ${String(row.current).padStart(4)}  (baseline ${before})${delta}${row.ok ? "" : "  REGRESSED"}`);
  }
  return lines.join("\n");
}

const REGRESSION_HINT = [
  "The SDK boundary regressed. Before raising the baseline:",
  "  - import through lib/pi/ (session-commands, events, entries, capabilities) when the SDK member is modelled there;",
  "  - otherwise isolate the new SDK access in a lib/pi/ module instead of the call site.",
  "If direct access is genuinely required, raise the baseline deliberately:",
  "  npm run drift:sdk -- --update",
  "and say why in the commit message.",
].join("\n");

function readBaseline(rootDir) {
  try {
    return JSON.parse(readFileSync(join(rootDir, BASELINE_FILE), "utf8"));
  } catch {
    return null;
  }
}

function writeBaseline(rootDir, metrics, previous) {
  const today = new Date().toISOString().slice(0, 10);
  const next = {
    schemaVersion: 1,
    updatedAt: today,
    note: "Ratchet for the SDK boundary; see scripts/measure-sdk-boundary.mjs and docs/architecture-improvement-plan.zh-CN.md (stage A5). Metrics may only go down.",
    reason: previous?.reason ?? "initial baseline after the lib/pi facade landing",
    metrics,
  };
  writeFileSync(join(rootDir, BASELINE_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function main(argv) {
  const json = argv.includes("--json");
  const update = argv.includes("--update");
  const { metrics } = measureSdkBoundary(ROOT);

  if (json) {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return 0;
  }

  if (update) {
    const previous = readBaseline(ROOT);
    const next = writeBaseline(ROOT, metrics, previous);
    process.stdout.write(formatReport(compareMetrics(metrics, next), next) + "\n");
    process.stdout.write(`\nBaseline written to ${BASELINE_FILE}.\n`);
    return 0;
  }

  const baseline = readBaseline(ROOT);
  if (!baseline) {
    process.stderr.write(`Missing ${BASELINE_FILE}. Create it with:\n  npm run drift:sdk -- --update\n`);
    return 1;
  }

  const rows = compareMetrics(metrics, baseline);
  process.stdout.write(`${formatReport(rows, baseline)}\n`);

  if (rows.every((row) => row.ok)) return 0;
  process.stderr.write(`\n${REGRESSION_HINT}\n`);
  return 1;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
