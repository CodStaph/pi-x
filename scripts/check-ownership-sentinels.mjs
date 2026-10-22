#!/usr/bin/env node
/**
 * Keeps scripts/fork-ownership.json and test/merge-guards/fork-extractions.test.mjs in
 * step (stage E1 of docs/architecture-improvement-plan.zh-CN.md).
 *
 * The merge sentinels are hand-written; the manifest is measured. Nothing tied
 * them together, so a file could be `high` risk with no sentinel (nothing would
 * catch a silent revert), and the manifest could keep listing a file that has
 * since been deleted, renamed or moved out of the fork.
 *
 * The check is deliberately static: it reads the two files, never imports the
 * test (which would register tests), and never runs git.
 *
 * Rules:
 *   1. every path in `driftedUpstreamFiles` still exists;
 *   2. every `high` entry has a sentinel in test/merge-guards/fork-extractions.test.mjs,
 *      or opts out with `"sentinels": "none"` plus a `sentinelReason`;
 *   3. an entry that opts out may not also be covered (the two would disagree);
 *   4. every `origin` in an extraction is a manifest entry — that file is the
 *      upstream-owned origin a merge would resurrect code into;
 *   5. every `movedTo` file exists (the fork-owned target of the move).
 *
 * Usage:
 *   node scripts/check-ownership-sentinels.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SENTINELS_FILE = "test/merge-guards/fork-extractions.test.mjs";

/** Paths named by the sentinel test: `file:` (coverage), `origin:`/`movedTo:` (extractions). */
export function readSentinels(rootDir = ROOT) {
  const source = readFileSync(join(rootDir, SENTINELS_FILE), "utf8");
  const covered = new Set();
  const origins = new Set();
  const movedTo = new Set();

  for (const match of source.matchAll(/\bfile: "([^"]+)"/g)) covered.add(match[1]);
  for (const match of source.matchAll(/\borigin: "([^"]+)"/g)) origins.add(match[1]);
  for (const match of source.matchAll(/\bmovedTo: \[([^\]]*)\]/g)) {
    for (const path of match[1].matchAll(/"([^"]+)"/g)) movedTo.add(path[1]);
  }

  // An extraction protects its origin from resurrection, so it is coverage too.
  for (const origin of origins) covered.add(origin);

  return { covered, origins, movedTo };
}

/** Every problem, as human-readable lines; empty means the two files agree. */
export function checkOwnershipSentinels({ rootDir = ROOT, manifest, sentinels } = {}) {
  const owned = manifest?.driftedUpstreamFiles ?? {};
  const read = sentinels ?? readSentinels(rootDir);
  const problems = [];

  for (const [path, entry] of Object.entries(owned)) {
    if (!existsSync(join(rootDir, path))) {
      problems.push(`${path} is in the manifest (risk: ${entry.risk}) but no longer exists — remove or rename the entry.`);
    }

    if (entry.risk !== "high") continue;
    // Two exemptions, both requiring a reason:
    //   "none"      — no guard is warranted (pure data, e.g. message strings);
    //   "elsewhere" — guarded, but outside test/merge-guards (a dedicated suite).
    const exemption = entry.sentinels === "none" || entry.sentinels === "elsewhere" ? entry.sentinels : null;
    const covered = read.covered.has(path);
    if (!covered && !exemption) {
      problems.push(
        `${path} is high risk but has no sentinel in ${SENTINELS_FILE}.`
          + ' Add one (so an upstream merge cannot silently revert it), or set `"sentinels": "none"`'
          + ' / `"sentinels": "elsewhere"` with a `sentinelReason`.',
      );
    }
    if (covered && exemption) {
      problems.push(
        `${path} declares \`"sentinels": "${exemption}"\` but a sentinel covers it — keep one of the two.`,
      );
    }
    if (exemption && !String(entry.sentinelReason ?? "").trim()) {
      problems.push(`${path} opts out of ${SENTINELS_FILE} without a \`sentinelReason\`.`);
    }
  }

  for (const origin of read.origins) {
    if (!owned[origin]) {
      problems.push(
        `${SENTINELS_FILE} protects ${origin}, which is not in the manifest — add it (with its measured risk) or drop the extraction.`,
      );
    }
  }

  for (const path of read.movedTo) {
    if (!existsSync(join(rootDir, path))) {
      problems.push(`${SENTINELS_FILE} says code moved to ${path}, which does not exist.`);
    }
  }

  return problems;
}

export function readManifest(rootDir = ROOT) {
  return JSON.parse(readFileSync(join(rootDir, "scripts/fork-ownership.json"), "utf8"));
}

function main() {
  const problems = checkOwnershipSentinels({ manifest: readManifest() });
  if (problems.length === 0) {
    console.log("ownership sentinels: every high-risk file is covered or explicitly exempt.");
    return 0;
  }
  console.error(`ownership sentinels: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`- ${problem}`);
  console.error("\nBoundary rules: docs/ownership-boundaries.md");
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
