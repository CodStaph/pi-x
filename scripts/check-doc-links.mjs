#!/usr/bin/env node
/**
 * Documentation link check (stage F1 of
 * docs/architecture-improvement-plan.zh-CN.md).
 *
 * The agent-facing docs — AGENTS.md, docs/agents/*, the ADRs — are read by humans
 * and by coding agents that jump straight to the file a sentence names. Their
 * whole value is pointer accuracy: a renamed module leaves a sentence that sends
 * the next reader (or agent) to a file that does not exist, and nothing fails.
 *
 * Two reference forms are checked:
 *
 *   - inline code that looks like a repository path (`lib/rpc-manager.ts`);
 *   - relative markdown links (`[x](../lib/rpc-manager.ts)`).
 *
 * Deliberately NOT checked, because they are not repository paths:
 *   - bare file names (`settings.json`, `core/usage-totals.ts`) — these name a
 *     file the app or the SDK reads at runtime, not a path in this repo;
 *   - URLs, `~/…`, `<placeholders>`, globs, `…`;
 *   - paths under a directory this repo does not own (`node_modules/`, `.next/`).
 *
 * A path that is deliberately gone (deleted module still discussed in the docs)
 * goes into `scripts/doc-link-allowlist.json` with a reason, so the exception is
 * reviewed rather than implied.
 *
 * Usage:
 *   node scripts/check-doc-links.mjs
 *   node scripts/check-doc-links.mjs --json
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOWLIST_FILE = "scripts/doc-link-allowlist.json";
const DOC_FILES = ["AGENTS.md", "CONTEXT.md", "README.md", "README.zh-CN.md"];

/** Top-level directories this repository owns; a reference must start with one of these. */
const OWNED_ROOTS = [
  "app/", "bin/", "components/", "demo/", "desktop/", "docs/", "e2e/", "hooks/",
  "lib/", "pi-workspace-manager/", "public/", "scripts/", "src-tauri/", "test/",
];

const FOREIGN_ROOTS = ["node_modules/", ".next/", ".next-desktop/", "src-tauri/target/", "src-tauri/resources/"];

/** Characters that mean the reference is prose, a template or a glob, not a path. */
const PROSE = /[*<>$`{}…]|\s/;

function isRepositoryPath(candidate, { allowRelative = false } = {}) {
  if (!candidate || PROSE.test(candidate)) return false;
  if (candidate.startsWith("~/") || candidate.startsWith("/") || /^[a-z]+:/i.test(candidate)) return false;
  if (FOREIGN_ROOTS.some((root) => candidate.startsWith(root))) return false;
  if (OWNED_ROOTS.some((root) => candidate.startsWith(root))) return true;
  // A markdown link is relative to its own file, so `./lib/x.ts` and
  // `../lib/x.ts` are repository references too.
  return allowRelative && (candidate.startsWith("./") || candidate.startsWith("../"));
}

/** Resolve a reference the way the reader would: root-relative, or file-relative for links. */
function resolveReference(file, reference) {
  const raw = reference.path.replace(/\/+$/, "");
  if (reference.form === "link" && (raw.startsWith("./") || raw.startsWith("../"))) {
    return posix.normalize(posix.join(posix.dirname(file), raw));
  }
  return posix.normalize(raw);
}

/** Inline-code paths plus relative markdown links, with the line each came from. */
export function extractReferences(source) {
  const references = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      // A backticked command (`npm run dev`) or a sentence fragment is skipped by
      // isRepositoryPath; a trailing punctuation mark is not part of the path.
      const candidate = match[1].trim().replace(/[),.;:]+$/, "");
      if (isRepositoryPath(candidate)) references.push({ path: candidate, line: index + 1, form: "code" });
    }
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1].split("#")[0].trim();
      if (isRepositoryPath(target, { allowRelative: true })) {
        references.push({ path: target, line: index + 1, form: "link" });
      }
    }
  });

  return references;
}

/** Markdown files that make up the agent-facing documentation. */
export function documentationFiles(rootDir = ROOT) {
  const files = DOC_FILES.filter((file) => existsSync(join(rootDir, file)));
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
        continue;
      }
      if (entry.name.endsWith(".md")) {
        // `rootDir` may or may not carry a trailing separator (the CLI default
        // comes from dirname(), the tests pass a URL-derived path).
        files.push(path.slice(rootDir.length).replace(/^[/\\]+/, "").split("\\").join("/"));
      }
    }
  };
  if (existsSync(join(rootDir, "docs"))) walk(join(rootDir, "docs"));
  return files;
}

export function readAllowlist(rootDir = ROOT) {
  const path = join(rootDir, ALLOWLIST_FILE);
  if (!existsSync(path)) return { paths: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { paths: parsed?.paths ?? {} };
  } catch (error) {
    throw new Error(`${ALLOWLIST_FILE} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Every unresolved reference. `ok: false` means the docs point at something that
 * is neither present nor explained by the allowlist.
 */
export function checkDocLinks({ rootDir = ROOT, allowlist } = {}) {
  const allowed = allowlist ?? readAllowlist(rootDir);
  const problems = [];
  let checked = 0;

  for (const file of documentationFiles(rootDir)) {
    const source = readFileSync(join(rootDir, file), "utf8");
    for (const reference of extractReferences(source)) {
      checked += 1;
      const target = resolveReference(file, reference);
      if (existsSync(join(rootDir, target))) continue;
      if (Object.prototype.hasOwnProperty.call(allowed.paths, target)) continue;
      problems.push({ file, line: reference.line, path: target, form: reference.form });
    }
  }

  return { checked, problems };
}

/** Allowlist entries that no longer match anything — stale exceptions. */
export function unusedAllowlistEntries({ rootDir = ROOT, allowlist } = {}) {
  const allowed = allowlist ?? readAllowlist(rootDir);
  const seen = new Set();
  for (const file of documentationFiles(rootDir)) {
    const source = readFileSync(join(rootDir, file), "utf8");
    for (const reference of extractReferences(source)) {
      seen.add(resolveReference(file, reference));
    }
  }
  return Object.keys(allowed.paths).filter((path) => !seen.has(path));
}

function main(argv) {
  const json = argv.includes("--json");
  const { checked, problems } = checkDocLinks();
  const stale = unusedAllowlistEntries();

  if (json) {
    process.stdout.write(`${JSON.stringify({ checked, problems, stale }, null, 2)}\n`);
    return problems.length === 0 && stale.length === 0 ? 0 : 1;
  }

  if (problems.length === 0 && stale.length === 0) {
    console.log(`docs: ${checked} reference(s) resolve.`);
    return 0;
  }

  if (problems.length > 0) {
    console.error(`docs: ${problems.length} unresolved reference(s)\n`);
    for (const problem of problems) {
      console.error(`- ${problem.file}:${problem.line}  ${problem.path}  (${problem.form})`);
    }
    console.error(`\nFix the sentence, or record a deliberate removal in ${ALLOWLIST_FILE}.`);
  }
  if (stale.length > 0) {
    console.error(`\ndocs: ${stale.length} allowlist entr${stale.length === 1 ? "y" : "ies"} no longer referenced:`);
    for (const path of stale) console.error(`- ${path}`);
    console.error(`Remove them from ${ALLOWLIST_FILE}.`);
  }
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2));
}
