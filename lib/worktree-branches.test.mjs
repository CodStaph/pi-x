import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { stripRemotePrefix, matchRemoteRefs, partitionBranchList, switchBranch } =
  await jiti.import("./worktree");

test("stripRemotePrefix extracts the branch name after the remote", async () => {
  assert.equal(stripRemotePrefix("origin/feature/x"), "feature/x");
  assert.equal(stripRemotePrefix("upstream/main"), "main");
  // No remote prefix (or a lone "/x") → null
  assert.equal(stripRemotePrefix("main"), null);
  assert.equal(stripRemotePrefix("/x"), null);
  assert.equal(stripRemotePrefix(""), null);
});

test("matchRemoteRefs finds refs whose branch part matches, across remotes", async () => {
  const refs = ["origin/main", "origin/feature/x", "upstream/feature/x", "origin/feature/x/y"];
  assert.deepEqual(matchRemoteRefs(refs, "main"), ["origin/main"]);
  assert.deepEqual(matchRemoteRefs(refs, "feature/x"), ["origin/feature/x", "upstream/feature/x"]);
  assert.deepEqual(matchRemoteRefs(refs, "missing"), []);
});

test("partitionBranchList splits local from remote-only branches", async () => {
  const result = partitionBranchList(
    ["main", "feature/x"],
    ["origin/main", "origin/feature/x", "origin/feature/y", "origin/HEAD", "upstream/feature/y", "upstream/feature/z"],
  );
  // Remote-only names are deduped across remotes and have no local branch.
  assert.deepEqual(result.remoteOnly, ["feature/y", "feature/z"]);
  assert.deepEqual(result.local, ["main", "feature/x"]);
});

test("switchBranch checks out local, remote-only, and rejects bad names", async (t) => {
  const gitAvailable = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  if (!gitAvailable) return t.skip("git not available");

  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const run = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const initRepo = (path) => {
    execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
    run(path, "config", "user.email", "test@example.com");
    run(path, "config", "user.name", "Test");
    return path;
  };

  const src = initRepo(join(dir, "src"));
  run(src, "commit", "--allow-empty", "-m", "main commit");
  run(src, "checkout", "-b", "feature/rag");
  run(src, "commit", "--allow-empty", "-m", "rag commit");
  run(src, "checkout", "main");

  // Clone sees origin/feature/rag but has no local feature/rag yet.
  const cloneDir = join(dir, "clone");
  execFileSync("git", ["clone", src, cloneDir], { stdio: "ignore" });

  // Remote-only branch: creates a local tracking branch.
  await switchBranch(cloneDir, "feature/rag");
  assert.equal(run(cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/rag");
  assert.equal(run(cloneDir, "config", "branch.feature/rag.remote"), "origin");

  // Local branch: plain checkout.
  await switchBranch(cloneDir, "main");
  assert.equal(run(cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "main");

  // Unknown branch → error, HEAD untouched.
  await assert.rejects(switchBranch(cloneDir, "does-not-exist"), /Branch not found/);
  assert.equal(run(cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "main");

  // Names that git would parse as options are rejected outright.
  await assert.rejects(switchBranch(cloneDir, "--upload-pack=x"), /Invalid branch name/);
});
