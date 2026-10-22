// Pins scripts/check-doc-links.mjs: which references count as repository paths,
// how the allowlist behaves, and that this repository's docs currently resolve.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkDocLinks,
  documentationFiles,
  extractReferences,
  readAllowlist,
  unusedAllowlistEntries,
} from "./check-doc-links.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "pi-doc-links-"));
  for (const [path, source] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

test("only repository paths are extracted", () => {
  const source = [
    "See `lib/rpc-manager.ts` and `app/api/agent/[id]/route.ts`.",
    "Commands like `npm run dev` and globs like `lib/pi/*` are not paths.",
    "A bare name such as `settings.json` names a runtime file, not a repo path.",
    "External links (https://example.com/x) and `~/pi-cwd` are skipped.",
    "A vendor path `node_modules/x/index.ts` is not ours.",
    "A link: [route](../lib/agent-client.ts#L28) and a directory `lib/pi/`.",
  ].join("\n");

  const paths = extractReferences(source).map((reference) => reference.path);
  // Order is per line (code before links), which is enough for reporting.
  assert.deepEqual(paths, [
    "lib/rpc-manager.ts",
    "app/api/agent/[id]/route.ts",
    "lib/pi/",
    "../lib/agent-client.ts",
  ]);

  // Line numbers point at the sentence, so a failure is actionable.
  const routed = extractReferences(source).find((reference) => reference.path === "lib/rpc-manager.ts");
  assert.equal(routed.line, 1);
  assert.equal(routed.form, "code");
});

test("a missing target is reported with file, line and path", () => {
  const root = fixture({
    "AGENTS.md": "Intro\n\nUse `lib/present.ts` and `lib/missing.ts`.\n",
    "lib/present.ts": "export {};\n",
    "docs/agent/notes.md": "Typo: `hooks/gone.ts`\n",
    "scripts/doc-link-allowlist.json": JSON.stringify({ paths: {} }),
  });
  try {
    const { checked, problems } = checkDocLinks({ rootDir: root });
    assert.equal(checked, 3);
    assert.deepEqual(problems.map((problem) => `${problem.file}:${problem.line} ${problem.path}`), [
      "AGENTS.md:3 lib/missing.ts",
      "docs/agent/notes.md:1 hooks/gone.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the allowlist excuses a path and reports stale entries", () => {
  const root = fixture({
    "AGENTS.md": "`lib/deleted.ts` stays deleted.\n",
    "components/X.tsx": "export {};\n",
    "scripts/doc-link-allowlist.json": JSON.stringify({
      paths: {
        "lib/deleted.ts": "removed upstream; the sentence stops a merge from reinstating it",
        "components/never-mentioned.tsx": "stale entry",
      },
    }),
  });
  try {
    assert.deepEqual(checkDocLinks({ rootDir: root }).problems, []);
    assert.deepEqual(unusedAllowlistEntries({ rootDir: root }), ["components/never-mentioned.tsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directories resolve too", () => {
  const root = fixture({
    "AGENTS.md": "Everything under `lib/pi/` is the facade.\n",
    "lib/pi/session-commands.ts": "export {};\n",
    "scripts/doc-link-allowlist.json": JSON.stringify({ paths: {} }),
  });
  try {
    assert.deepEqual(checkDocLinks({ rootDir: root }).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the documentation surface includes docs/**/*.md", () => {
  const files = documentationFiles(repoRoot);
  assert.ok(files.includes("AGENTS.md"));
  assert.ok(files.includes("docs/agents/sessions.md"));
  assert.ok(files.includes("docs/adr/0006-mcp-and-code-mode.md"));
  assert.ok(!files.some((file) => file.startsWith("node_modules/")));
});

test("this repository's documentation resolves and the allowlist has no stale entries", () => {
  const { checked, problems } = checkDocLinks({ rootDir: repoRoot });
  assert.ok(checked > 300, `expected a meaningful sample, checked ${checked}`);
  assert.deepEqual(problems, []);
  assert.deepEqual(unusedAllowlistEntries({ rootDir: repoRoot, allowlist: readAllowlist(repoRoot) }), []);
});
