import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout.trim();
}

/** Read a file with line endings normalized, so the assertions are OS-independent. */
async function readText(filePath) {
  return (await readFile(filePath, "utf8")).replace(/\r\n/g, "\n");
}

/** Stand-in for the Pi `ExtensionAPI` surface this extension uses. */
function makePi() {
  const tools = new Map();
  const commands = new Map();
  return {
    tools,
    commands,
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    on() {},
    exec(command, args, options = {}) {
      return new Promise((resolvePromise) => {
        execFile(command, args, { timeout: options.timeout ?? 60_000, signal: options.signal }, (error, stdout, stderr) => {
          resolvePromise({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            killed: Boolean(error && error.killed),
          });
        });
      });
    },
  };
}

function textOf(result) {
  return result.content.map((part) => part.text).join("\n");
}

async function callTool(pi, name, params, cwd) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  return tool.execute("test-call", params ?? {}, undefined, undefined, { cwd });
}

const root = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-manager-"));
const main = path.join(root, "repo");
const worktree = path.join(root, "repo-worktrees", "feature");

const pi = makePi();
const { default: workspaceManager, isSensitivePath } = await import("../extensions/workspace-manager.ts");
workspaceManager(pi);

before(async () => {
  await mkdir(main, { recursive: true });
  await git(main, ["init"]);
  await git(main, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(main, ["config", "user.email", "test@example.com"]);
  await git(main, ["config", "user.name", "Pi Test"]);
  // Keep the test's own line endings so file assertions are OS-independent.
  await git(main, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(main, "file.txt"), "base\n");
  await git(main, ["add", "-A"]);
  await git(main, ["commit", "-m", "init"]);
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(main, ["worktree", "add", "-b", "feature", worktree, "main"]);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("isSensitivePath flags secrets but not templates", () => {
  assert.equal(isSensitivePath(".env"), true);
  assert.equal(isSensitivePath("config/.env.local"), true);
  assert.equal(isSensitivePath("certs/server.pem"), true);
  assert.equal(isSensitivePath("keys/id_ed25519"), true);
  assert.equal(isSensitivePath(".env.example"), false);
  assert.equal(isSensitivePath("docs/README.md"), false);
});

test("workspace_status describes the linked worktree and its base", async () => {
  const result = await callTool(pi, "workspace_status", {}, worktree);
  const text = textOf(result);
  assert.match(text, /mode: linked worktree/);
  assert.match(text, /branch: feature/);
  assert.match(text, /base: main/);
  assert.match(text, /checkpoints: none/);
});

test("workspace_merge checkpoints the worktree and merges it into the base", async () => {
  await writeFile(path.join(worktree, "file.txt"), "changed in worktree\n");

  const result = await callTool(pi, "workspace_merge", { message: "merge feature" }, worktree);
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /Merged workspace/);
  assert.match(textOf(result), /pre-merge checkpoint: #1/);

  // The base now contains the worktree change, as a two-parent merge commit.
  assert.equal(await readText(path.join(main, "file.txt")), "changed in worktree\n");
  const parents = (await git(main, ["log", "-1", "--format=%P"])).split(" ").filter(Boolean);
  assert.equal(parents.length, 2, "workspace_merge must create a merge commit");

  const checkpoints = await git(main, ["for-each-ref", "--format=%(refname)", "refs/pi/checkpoints/"]);
  assert.match(checkpoints, /refs\/pi\/checkpoints\/[0-9a-f]+\/1/);
  const merges = await git(main, ["for-each-ref", "--format=%(refname)", "refs/pi/merges/"]);
  assert.match(merges, /refs\/pi\/merges\/[0-9a-f]+\/1\/base/);
  assert.match(merges, /refs\/pi\/merges\/[0-9a-f]+\/1\/head/);
});

test("workspace_revert undoes the recorded merge with git revert", async () => {
  const result = await callTool(pi, "workspace_revert", {}, worktree);
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /Reverted merge/);
  assert.equal(await readText(path.join(main, "file.txt")), "base\n");

  const reverts = await git(main, ["for-each-ref", "--format=%(refname)", "refs/pi/merges/"]);
  assert.match(reverts, /refs\/pi\/merges\/[0-9a-f]+\/1\/revert/);
});

test("workspace_merge refuses sensitive-looking untracked files", async () => {
  await writeFile(path.join(worktree, "wt-only.txt"), "worktree change\n");
  await writeFile(path.join(worktree, ".env"), "TOKEN=secret\n");

  const result = await callTool(pi, "workspace_merge", {}, worktree);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /sensitive/i);
  // The base was not touched.
  assert.equal(await readText(path.join(main, "file.txt")), "base\n");

  await rm(path.join(worktree, ".env"), { force: true });
});

test("workspace_merge auto-syncs the base into the worktree", async () => {
  // Align file.txt with the base and change a separate file, so the sync is clean.
  await writeFile(path.join(worktree, "file.txt"), "base\n");
  await writeFile(path.join(main, "base-only.txt"), "base move\n");
  await git(main, ["add", "-A"]);
  await git(main, ["commit", "-m", "base moves on"]);

  const result = await callTool(pi, "workspace_merge", {}, worktree);
  assert.ok(!result.isError, textOf(result));
  // Both sides landed on the base.
  assert.equal(await readText(path.join(main, "file.txt")), "base\n");
  assert.equal(await readText(path.join(main, "base-only.txt")), "base move\n");
  assert.equal(await readText(path.join(main, "wt-only.txt")), "worktree change\n");
});

test("workspace_merge reports a sync conflict without touching the base", async () => {
  await writeFile(path.join(worktree, "file.txt"), "worktree wins\n");
  await writeFile(path.join(main, "file.txt"), "base wins\n");
  await git(main, ["add", "-A"]);
  await git(main, ["commit", "-m", "conflicting base change"]);

  const before = await git(main, ["rev-parse", "HEAD"]);
  const result = await callTool(pi, "workspace_merge", {}, worktree);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /sync-conflict/);
  assert.equal(await git(main, ["rev-parse", "HEAD"]), before, "base must be unchanged after a sync conflict");
});

test("the /workspace command is registered", () => {
  assert.ok(pi.commands.get("workspace"));
});

// ---------------------------------------------------------------------------
// P1: create / sync / rollback / list / diff / prune (each on its own repo)
// ---------------------------------------------------------------------------

/** Fresh repo with one commit; the worktree is created by workflow_create itself. */
async function makeRepo(name) {
  const repo = path.join(root, name, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Pi Test"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "file.txt"), "base\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "init"]);
  return { repo };
}

test("workspace_create makes a worktree and records its base", async () => {
  const { repo } = await makeRepo("p1-create");
  const created = await callTool(pi, "workspace_create", { branch: "feature", base: "main" }, repo);
  assert.ok(!created.isError, textOf(created));
  const { ws, worktree, base } = created.details;
  assert.equal(base, "main");
  assert.ok(existsSync(worktree), "worktree path exists");
  assert.equal(await git(repo, ["symbolic-ref", "--short", `refs/pi/workspaces/${ws}/base`]), "main");

  const status = await callTool(pi, "workspace_status", {}, worktree);
  assert.match(textOf(status), /mode: linked worktree/);
  assert.match(textOf(status), /branch: feature/);
  assert.match(textOf(status), /base: main/);
});

test("workspace_sync brings the base branch into the worktree", async () => {
  const { repo } = await makeRepo("p1-sync");
  const created = await callTool(pi, "workspace_create", { branch: "sync", base: "main" }, repo);
  const { worktree } = created.details;

  await writeFile(path.join(repo, "base.txt"), "base\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "base change"]);

  const synced = await callTool(pi, "workspace_sync", {}, worktree);
  assert.ok(!synced.isError, textOf(synced));
  assert.equal(await readText(path.join(worktree, "base.txt")), "base\n");
});

test("workspace_rollback restores tracked files and keeps untracked ones", async () => {
  const { repo } = await makeRepo("p1-rollback");
  const created = await callTool(pi, "workspace_create", { branch: "rollback", base: "main" }, repo);
  const { worktree } = created.details;

  await writeFile(path.join(worktree, "file.txt"), "v1\n");
  await callTool(pi, "workspace_checkpoint", { label: "v1" }, worktree);
  await writeFile(path.join(worktree, "file.txt"), "v2\n");
  await writeFile(path.join(worktree, "untracked.txt"), "leave me\n");

  const rolled = await callTool(pi, "workspace_rollback", {}, worktree);
  assert.ok(!rolled.isError, textOf(rolled));
  assert.equal(await readText(path.join(worktree, "file.txt")), "v1\n");
  assert.equal(await readText(path.join(worktree, "untracked.txt")), "leave me\n");
});

test("workspace_diff shows committed and uncommitted changes", async () => {
  const { repo } = await makeRepo("p1-diff");
  const created = await callTool(pi, "workspace_create", { branch: "diff", base: "main" }, repo);
  const { worktree } = created.details;

  await writeFile(path.join(worktree, "file.txt"), "committed\n");
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["commit", "-m", "change"]);
  await writeFile(path.join(worktree, "extra.txt"), "uncommitted\n");

  const diff = await callTool(pi, "workspace_diff", { stat: true }, worktree);
  assert.ok(!diff.isError, textOf(diff));
  const text = textOf(diff);
  assert.match(text, /file\.txt/);
  assert.match(text, /extra\.txt/);
});

test("workspace_list and workspace_prune manage recorded refs", async () => {
  const { repo } = await makeRepo("p1-prune");
  const created = await callTool(pi, "workspace_create", { branch: "prune", base: "main" }, repo);
  const { ws, worktree } = created.details;

  await writeFile(path.join(worktree, "file.txt"), "v1\n");
  await callTool(pi, "workspace_checkpoint", {}, worktree);
  await callTool(pi, "workspace_checkpoint", {}, worktree);

  const listed = await callTool(pi, "workspace_list", {}, worktree);
  assert.match(textOf(listed), new RegExp(`workspace ${ws}`));

  const pruned = await callTool(pi, "workspace_prune", { seq: 1 }, worktree);
  assert.ok(!pruned.isError, textOf(pruned));
  const remaining = await git(repo, ["for-each-ref", "--format=%(refname)", "refs/pi/checkpoints/"]);
  assert.doesNotMatch(remaining, /\/1$/);
  assert.match(remaining, /\/2$/);

  const all = await callTool(pi, "workspace_prune", { all: true }, worktree);
  assert.ok(!all.isError, textOf(all));
  assert.equal(await git(repo, ["for-each-ref", "--format=%(refname)", "refs/pi/checkpoints/"]), "");
});
