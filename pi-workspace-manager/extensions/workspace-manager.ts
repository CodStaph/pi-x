/**
 * Workspace Manager — a Pi extension (no UI) that gives the agent a
 * checkpoint / merge / revert workflow on top of git worktrees.
 *
 * Model:
 *   - The *base* checkout is the user's local repo on its normal branch.
 *   - The *worktree* is a linked `git worktree` where the agent/user edits.
 *   - Checkpoints are tracked-only snapshots stored under an independent ref
 *     namespace (`refs/pi/checkpoints/<ws>/<n>`), created before each merge.
 *   - `workspace_merge` merges the worktree branch back into the base with a
 *     merge commit (`git merge --no-ff`).
 *   - `workspace_revert` undoes a recorded merge on the base with
 *     `git revert -m 1` — never `reset --hard`.
 *
 * Design decisions baked in (from the agreed spec):
 *   - extension only, no pi-web UI;
 *   - independent ref namespace for checkpoints;
 *   - checkpoints are created before each merge (plus the manual tool);
 *   - merge commit is the default and only merge strategy;
 *   - base rollback is revert-only;
 *   - checkpoints exclude untracked files (`.env`, build output, ...);
 *   - assume the user already cloned the repo (no clone here).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Small result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface GitRunner {
  run(cwd: string, args: string[], timeout?: number): Promise<GitResult>;
  must(cwd: string, args: string[], timeout?: number): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 5 * 60_000;

/** argv-only git runner; never goes through a shell. */
function makeGit(pi: ExtensionAPI, signal?: AbortSignal): GitRunner {
  return {
    run(cwd, args, timeout = DEFAULT_TIMEOUT_MS) {
      return pi.exec("git", ["-C", cwd, ...args], { timeout, signal });
    },
    async must(cwd, args, timeout) {
      const result = await pi.exec("git", ["-C", cwd, ...args], { timeout, signal });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(`git ${args.join(" ")} failed: ${detail}`);
      }
      return result.stdout.trim();
    },
  };
}

/** Lines of a git command's stdout, trimmed and without blanks. */
function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Paths and the workspace identity
// ---------------------------------------------------------------------------

/** Git may print `/d/repo` for `D:\repo`; normalize before `resolve`. */
function toNativePath(value: string): string {
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(value);
  if (process.platform === "win32" && drive) {
    return `${drive[1].toUpperCase()}:\\${drive[2].replace(/\//g, "\\")}`;
  }
  return value;
}

function normalizePath(value: string): string {
  const normalized = normalize(resolve(toNativePath(value)));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Stable id derived from the shared git dir plus the worktree branch. */
function workspaceId(commonDir: string, branch: string): string {
  return createHash("sha1").update(`${normalizePath(commonDir)}\n${branch}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Repo / workspace resolution
// ---------------------------------------------------------------------------

interface RepoContext {
  /** The directory the tool was called from (the worktree, normally). */
  cwd: string;
  /** Working tree of the main checkout (the "local repo"). */
  mainRepo: string;
  commonDir: string;
  gitDir: string;
  /** Current branch of `cwd`; null on a detached HEAD. */
  branch: string | null;
  /** True when `cwd` is a linked worktree, not the main checkout. */
  isLinkedWorktree: boolean;
  /** Workspace identity shared by the checkpoints/merges refs. */
  ws: string;
  /** Branch merges target in the main checkout. */
  baseBranch: string | null;
}

async function inferBaseBranch(g: GitRunner, mainRepo: string): Promise<string | null> {
  const result = await g.run(mainRepo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** The base branch recorded as a symbolic ref by a future `workspace_create`. */
async function readRecordedBaseBranch(g: GitRunner, mainRepo: string, ws: string): Promise<string | null> {
  const result = await g.run(mainRepo, ["symbolic-ref", "--quiet", "--short", `refs/pi/workspaces/${ws}/base`]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

async function resolveRepoContext(g: GitRunner, cwd: string, explicitBase?: string): Promise<RepoContext> {
  const out = await g.must(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--git-dir",
    "--abbrev-ref",
    "HEAD",
  ]);
  const [commonDirRaw, gitDirRaw, ref] = out.split("\n").map((line) => line.trim());
  if (!commonDirRaw || !gitDirRaw) throw new Error("Not a git repository.");

  const commonDir = resolvePath(commonDirRaw);
  const gitDir = resolvePath(gitDirRaw);
  const mainRepo = dirname(commonDir);
  const isLinkedWorktree = !samePath(commonDir, gitDir);
  const branch = ref && ref !== "HEAD" ? ref : null;
  const ws = workspaceId(commonDir, branch ?? "detached");
  const baseBranch =
    explicitBase?.trim() ||
    (await readRecordedBaseBranch(g, mainRepo, ws)) ||
    (await inferBaseBranch(g, mainRepo));

  return { cwd, mainRepo, commonDir, gitDir, branch, isLinkedWorktree, ws, baseBranch };
}

function resolvePath(value: string): string {
  return normalize(resolve(toNativePath(value)));
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

async function listRefs(g: GitRunner, cwd: string, prefix: string): Promise<Array<{ name: string; object: string }>> {
  const out = await g.must(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", `${prefix}/`]);
  const refs: Array<{ name: string; object: string }> = [];
  for (const line of lines(out)) {
    const space = line.lastIndexOf(" ");
    if (space < 0) continue;
    refs.push({ name: line.slice(0, space), object: line.slice(space + 1) });
  }
  return refs;
}

function nextSequence(refs: readonly { name: string }[], segmentFromEnd: number): number {
  let max = 0;
  for (const { name } of refs) {
    const parts = name.split("/");
    const segment = parts[parts.length - segmentFromEnd];
    const seq = Number(segment);
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Checkpoints (tracked-only snapshots under an independent ref namespace)
// ---------------------------------------------------------------------------

interface CheckpointInfo {
  seq: number;
  ref: string;
  commit: string;
  /** False when there were no tracked changes, so the checkpoint is HEAD. */
  captured: boolean;
  label: string | null;
}

async function createCheckpoint(g: GitRunner, cwd: string, label?: string): Promise<CheckpointInfo> {
  const repo = await resolveRepoContext(g, cwd);
  const message = label ? `pi checkpoint ${label}` : "pi checkpoint";
  // `git stash create` snapshots tracked changes only, without touching the
  // working tree or the real index, and returns a commit object name.
  const stash = await g.run(repo.cwd, ["stash", "create", message]);
  let commit: string;
  let captured: boolean;
  if (stash.code === 0 && stash.stdout.trim()) {
    commit = stash.stdout.trim();
    captured = true;
  } else {
    commit = await g.must(repo.cwd, ["rev-parse", "HEAD"]);
    captured = false;
  }

  const seq = nextSequence(await listRefs(g, repo.mainRepo, `refs/pi/checkpoints/${repo.ws}`), 1);
  const ref = `refs/pi/checkpoints/${repo.ws}/${seq}`;
  await g.must(repo.mainRepo, ["update-ref", ref, commit]);
  return { seq, ref, commit, captured, label: label ?? null };
}

async function listCheckpoints(g: GitRunner, cwd: string, ws: string): Promise<CheckpointInfo[]> {
  const refs = await listRefs(g, cwd, `refs/pi/checkpoints/${ws}`);
  return refs
    .map(({ name, object }) => {
      const seq = Number(name.split("/").at(-1));
      return { seq, ref: name, commit: object, captured: true, label: null };
    })
    .filter((entry) => Number.isInteger(entry.seq))
    .sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Merge bookkeeping (refs/pi/merges/<ws>/<seq>/{base,source,head,revert})
// ---------------------------------------------------------------------------

interface MergeRecord {
  seq: number;
  base?: string;
  source?: string;
  head?: string;
  revert?: string;
}

async function listMerges(g: GitRunner, cwd: string, ws: string): Promise<MergeRecord[]> {
  const refs = await listRefs(g, cwd, `refs/pi/merges/${ws}`);
  const bySeq = new Map<number, MergeRecord>();
  for (const { name, object } of refs) {
    const parts = name.split("/");
    // refs/pi/merges/<ws>/<seq>/<kind>
    const seq = Number(parts[4]);
    const kind = parts[5];
    if (!Number.isInteger(seq) || !kind) continue;
    const record = bySeq.get(seq) ?? { seq };
    if (kind === "base") record.base = object;
    else if (kind === "source") record.source = object;
    else if (kind === "head") record.head = object;
    else if (kind === "revert") record.revert = object;
    bySeq.set(seq, record);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Sensitive-file policy
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.envrc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\..+)?$/i,
  /(^|\/)secrets?(\..+)?$/i,
];

/** `.env.example` / `.sample` / `.template` are templates, not secrets. */
export function isSensitivePath(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  if (/\.(example|sample|template)$/i.test(base)) return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath) || pattern.test(base));
}

async function listChangedPaths(g: GitRunner, cwd: string): Promise<string[]> {
  const [untracked, modified, staged] = await Promise.all([
    g.must(cwd, ["ls-files", "--others", "--exclude-standard"]),
    g.must(cwd, ["diff", "--name-only"]),
    g.must(cwd, ["diff", "--cached", "--name-only"]),
  ]);
  const set = new Set<string>();
  for (const block of [untracked, modified, staged]) {
    for (const name of lines(block)) set.add(name);
  }
  return [...set];
}

async function conflictedPaths(g: GitRunner, cwd: string): Promise<string[]> {
  return lines(await g.must(cwd, ["diff", "--name-only", "--diff-filter=U"]));
}

// ---------------------------------------------------------------------------
// Sync (base -> worktree)
// ---------------------------------------------------------------------------

interface SyncOutcome {
  ok: boolean;
  alreadySynced: boolean;
  baseBefore: string;
  sourceCommit: string;
  reason?: "sync-conflict";
  message?: string;
  conflicts?: string[];
}

async function syncBaseIntoWorktree(
  g: GitRunner,
  repo: RepoContext,
  baseBranch = repo.baseBranch,
): Promise<SyncOutcome> {
  if (!baseBranch) throw new Error("Could not determine the base branch; pass `base` explicitly.");
  const baseBefore = await g.must(repo.mainRepo, ["rev-parse", `${baseBranch}^{commit}`]);
  const head = await g.must(repo.cwd, ["rev-parse", "HEAD"]);
  const ancestor = await g.run(repo.cwd, ["merge-base", "--is-ancestor", baseBefore, head]);
  if (ancestor.code === 0) {
    return { ok: true, alreadySynced: true, baseBefore, sourceCommit: head };
  }
  const sync = await g.run(
    repo.cwd,
    ["merge", "--no-ff", "-m", `pi: sync ${baseBranch} into workspace ${repo.ws}`, baseBefore],
    MERGE_TIMEOUT_MS,
  );
  if (sync.code !== 0) {
    const conflicts = await conflictedPaths(g, repo.cwd);
    await g.run(repo.cwd, ["merge", "--abort"]);
    return {
      ok: false,
      alreadySynced: false,
      baseBefore,
      sourceCommit: head,
      reason: "sync-conflict",
      message:
        (sync.stderr.trim() || sync.stdout.trim() || "sync merge failed") +
        ` (aborted; base unchanged). Resolve by merging '${baseBranch}' into the worktree manually, then retry.`,
      conflicts,
    };
  }
  const sourceCommit = await g.must(repo.cwd, ["rev-parse", "HEAD"]);
  return { ok: true, alreadySynced: false, baseBefore, sourceCommit };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

interface MergeParams {
  message?: string;
  base?: string;
  checkpointLabel?: string;
  allowSensitive?: boolean;
}

type MergeOutcome =
  | {
      ok: true;
      ws: string;
      checkpoint: CheckpointInfo;
      seq: number;
      committed: boolean;
      mergeCommit: string;
      sourceCommit: string;
      baseBefore: string;
    }
  | {
      ok: false;
      reason: "nothing-to-merge" | "sync-conflict" | "merge-conflict";
      message: string;
      conflicts?: string[];
    };

async function performMerge(g: GitRunner, cwd: string, params: MergeParams): Promise<MergeOutcome> {
  const repo = await resolveRepoContext(g, cwd, params.base);
  if (!repo.isLinkedWorktree) {
    throw new Error("workspace_merge must run from a linked worktree (git worktree add), not the main checkout.");
  }
  if (!repo.branch) throw new Error("HEAD is detached; check out the worktree branch first.");
  if (!repo.baseBranch) {
    throw new Error("Could not determine the base branch; pass `base` explicitly (e.g. main).");
  }
  if (samePath(repo.branch, repo.baseBranch)) {
    throw new Error(`The worktree branch and the base branch are both '${repo.branch}'.`);
  }

  const baseStatus = await g.must(repo.mainRepo, ["status", "--porcelain"]);
  if (baseStatus.trim()) {
    throw new Error(`The base checkout is not clean; commit or stash its changes first:\n${baseStatus.trim()}`);
  }

  // 1) pre-merge checkpoint (tracked-only snapshot of the worktree)
  const checkpoint = await createCheckpoint(g, repo.cwd, params.checkpointLabel ?? "before merge");

  // 2) refuse to commit sensitive-looking files unless explicitly allowed
  if (!params.allowSensitive) {
    const sensitive = (await listChangedPaths(g, repo.cwd)).filter(isSensitivePath);
    if (sensitive.length > 0) {
      throw new Error(
        `Refusing to commit sensitive-looking files: ${sensitive.join(", ")}. ` +
          "Move them out, add them to .gitignore, or pass allowSensitive=true.",
      );
    }
  }

  // 3) commit tracked + new (non-ignored) worktree changes so the merge carries them
  await g.must(repo.cwd, ["add", "-A"]);
  const staged = await g.run(repo.cwd, ["diff", "--cached", "--quiet"]);
  let committed = false;
  if (staged.code !== 0) {
    await g.must(repo.cwd, ["commit", "-m", params.message ?? `pi: workspace ${repo.ws} checkpoint ${checkpoint.seq}`]);
    committed = true;
  }

  // 4) bring the base into the worktree first, so the base merge cannot conflict
  const sync = await syncBaseIntoWorktree(g, repo);
  if (!sync.ok) {
    return { ok: false, reason: sync.reason ?? "sync-conflict", message: sync.message ?? "sync failed", conflicts: sync.conflicts };
  }
  const baseBefore = sync.baseBefore;
  const sourceCommit = sync.sourceCommit;

  if (sourceCommit === baseBefore) {
    return {
      ok: false,
      reason: "nothing-to-merge",
      message: "The worktree has no changes relative to the base; nothing to merge.",
    };
  }

  // 5) record the merge attempt, then merge with a merge commit
  const seq = nextSequence(await listRefs(g, repo.mainRepo, `refs/pi/merges/${repo.ws}`), 2);
  const prefix = `refs/pi/merges/${repo.ws}/${seq}`;
  await g.must(repo.mainRepo, ["update-ref", `${prefix}/base`, baseBefore]);
  await g.must(repo.mainRepo, ["update-ref", `${prefix}/source`, sourceCommit]);

  const message = params.message ?? `pi: merge workspace ${repo.ws}`;
  const merge = await g.run(repo.mainRepo, ["merge", "--no-ff", "-m", message, sourceCommit], MERGE_TIMEOUT_MS);
  if (merge.code !== 0) {
    const conflicts = await conflictedPaths(g, repo.mainRepo);
    await g.run(repo.mainRepo, ["merge", "--abort"]);
    return {
      ok: false,
      reason: "merge-conflict",
      message: (merge.stderr.trim() || merge.stdout.trim() || "merge failed") + " (aborted; base unchanged)",
      conflicts,
    };
  }

  const mergeCommit = await g.must(repo.mainRepo, ["rev-parse", "HEAD"]);
  await g.must(repo.mainRepo, ["update-ref", `${prefix}/head`, mergeCommit]);
  return { ok: true, ws: repo.ws, checkpoint, seq, committed, mergeCommit, sourceCommit, baseBefore };
}

// ---------------------------------------------------------------------------
// Revert (base rollback — revert-only, never reset)
// ---------------------------------------------------------------------------

interface RevertParams {
  seq?: number;
  mergeCommit?: string;
  base?: string;
}

type RevertOutcome =
  | { ok: true; mergeCommit: string; revertCommit: string; seq: number | null }
  | { ok: false; reason: "revert-conflict"; message: string; conflicts: string[]; mergeCommit: string };

async function performRevert(g: GitRunner, cwd: string, params: RevertParams): Promise<RevertOutcome> {
  const repo = await resolveRepoContext(g, cwd, params.base);

  const baseStatus = await g.must(repo.mainRepo, ["status", "--porcelain"]);
  if (baseStatus.trim()) {
    throw new Error(`The base checkout is not clean; commit or stash its changes first:\n${baseStatus.trim()}`);
  }

  let mergeCommit = params.mergeCommit?.trim() || "";
  let seq = params.seq ?? null;
  if (!mergeCommit) {
    const merges = (await listMerges(g, repo.mainRepo, repo.ws)).filter((record) => record.head && !record.revert);
    const chosen = seq !== null ? merges.find((record) => record.seq === seq) : merges.at(-1);
    if (!chosen?.head) {
      throw new Error(
        seq !== null
          ? `No un-reverted merge recorded for this workspace at seq ${seq}.`
          : "No un-reverted merge recorded for this workspace.",
      );
    }
    mergeCommit = chosen.head;
    seq = chosen.seq;
  }

  const revert = await g.run(repo.mainRepo, ["revert", "--no-edit", "-m", "1", mergeCommit]);
  if (revert.code !== 0) {
    const conflicts = await conflictedPaths(g, repo.mainRepo);
    await g.run(repo.mainRepo, ["revert", "--abort"]);
    return {
      ok: false,
      reason: "revert-conflict",
      message: (revert.stderr.trim() || revert.stdout.trim() || "revert failed") + " (aborted; base unchanged)",
      conflicts,
      mergeCommit,
    };
  }

  const revertCommit = await g.must(repo.mainRepo, ["rev-parse", "HEAD"]);
  if (seq !== null) {
    await g.must(repo.mainRepo, ["update-ref", `refs/pi/merges/${repo.ws}/${seq}/revert`, revertCommit]);
  }
  return { ok: true, mergeCommit, revertCommit, seq };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function buildStatus(g: GitRunner, cwd: string): Promise<{ text: string; details: Record<string, unknown> }> {
  const repo = await resolveRepoContext(g, cwd);
  const baseStatus = (await g.must(repo.mainRepo, ["status", "--porcelain"])).trim();
  const worktreeStatus = (await g.must(repo.cwd, ["status", "--porcelain"])).trim();
  const checkpoints = await listCheckpoints(g, repo.mainRepo, repo.ws);
  const merges = await listMerges(g, repo.mainRepo, repo.ws);

  const linesOut: string[] = [];
  linesOut.push(`workspace: ${repo.ws}`);
  linesOut.push(`mode: ${repo.isLinkedWorktree ? "linked worktree" : "main checkout"}`);
  linesOut.push(`branch: ${repo.branch ?? "(detached HEAD)"}`);
  linesOut.push(`base: ${repo.baseBranch ?? "(unknown)"}`);
  linesOut.push(`main checkout: ${repo.mainRepo}`);
  linesOut.push(`base clean: ${baseStatus ? "no (uncommitted changes)" : "yes"}`);
  linesOut.push(`worktree clean: ${worktreeStatus ? "no" : "yes"}`);
  linesOut.push(
    checkpoints.length
      ? `checkpoints:\n${checkpoints.map((cp) => `  #${cp.seq} ${cp.commit.slice(0, 12)}${cp.label ? ` (${cp.label})` : ""}`).join("\n")}`
      : "checkpoints: none",
  );
  linesOut.push(
    merges.length
      ? `merges:\n${merges
          .map(
            (record) =>
              `  #${record.seq} head ${record.head?.slice(0, 12) ?? "-"}${record.revert ? ` reverted as ${record.revert.slice(0, 12)}` : ""}`,
          )
          .join("\n")}`
      : "merges: none",
  );

  return {
    text: linesOut.join("\n"),
    details: {
      ws: repo.ws,
      isLinkedWorktree: repo.isLinkedWorktree,
      branch: repo.branch,
      baseBranch: repo.baseBranch,
      mainRepo: repo.mainRepo,
      baseDirty: baseStatus.length > 0,
      worktreeDirty: worktreeStatus.length > 0,
      checkpoints,
      merges,
    },
  };
}

// ---------------------------------------------------------------------------
// workspace_create
// ---------------------------------------------------------------------------

interface CreateParams {
  branch: string;
  base?: string;
  path?: string;
}

interface CreateOutcome {
  ws: string;
  branch: string;
  base: string;
  worktree: string;
  createdBranch: boolean;
}

function sanitizeBranchForDir(branch: string): string {
  return branch.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

async function performCreate(g: GitRunner, cwd: string, params: CreateParams): Promise<CreateOutcome> {
  const branch = params.branch?.trim();
  if (!branch) throw new Error("branch is required.");
  if (branch.startsWith("-")) throw new Error("Invalid branch name.");

  const repo = await resolveRepoContext(g, cwd);
  const base = params.base?.trim() || repo.baseBranch || (await inferBaseBranch(g, repo.mainRepo));
  if (!base) throw new Error("Could not determine the base branch; pass `base` explicitly.");

  const ws = workspaceId(repo.commonDir, branch);
  const worktree = params.path?.trim()
    ? resolve(cwd, params.path.trim())
    : join(dirname(repo.mainRepo), `${basename(repo.mainRepo)}-worktrees`, sanitizeBranchForDir(branch));
  if (existsSync(worktree)) throw new Error(`Path already exists: ${worktree}`);
  mkdirSync(dirname(worktree), { recursive: true });

  const exists = await g.run(repo.mainRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const createdBranch = exists.code !== 0;
  if (createdBranch) {
    await g.must(repo.mainRepo, ["worktree", "add", "-b", branch, worktree, base], MERGE_TIMEOUT_MS);
  } else {
    await g.must(repo.mainRepo, ["worktree", "add", worktree, branch], MERGE_TIMEOUT_MS);
  }
  // Record the merge target for this workspace (read back by resolveRepoContext).
  await g.must(repo.mainRepo, ["symbolic-ref", `refs/pi/workspaces/${ws}/base`, `refs/heads/${base}`]);
  return { ws, branch, base, worktree, createdBranch };
}

// ---------------------------------------------------------------------------
// workspace_rollback
// ---------------------------------------------------------------------------

interface RollbackParams {
  seq?: number;
  ref?: string;
  hard?: boolean;
}

interface RollbackOutcome {
  checkpoint: CheckpointInfo;
  mode: "restore" | "hard";
  changedFiles: string[];
  untrackedRemaining: string[];
}

async function listUntracked(g: GitRunner, cwd: string): Promise<string[]> {
  return lines(await g.must(cwd, ["ls-files", "--others", "--exclude-standard"]));
}

async function performRollback(g: GitRunner, cwd: string, params: RollbackParams): Promise<RollbackOutcome> {
  const repo = await resolveRepoContext(g, cwd);
  if (!repo.isLinkedWorktree) {
    throw new Error("workspace_rollback must run from a linked worktree; refusing to touch the main checkout.");
  }

  const checkpoints = await listCheckpoints(g, repo.mainRepo, repo.ws);
  let checkpoint: CheckpointInfo | undefined;
  if (params.ref?.trim()) {
    const ref = params.ref.trim();
    const commit = await g.must(repo.mainRepo, ["rev-parse", "--verify", `${ref}^{commit}`]);
    checkpoint = { seq: -1, ref, commit, captured: true, label: null };
  } else if (params.seq !== undefined) {
    checkpoint = checkpoints.find((entry) => entry.seq === params.seq);
    if (!checkpoint) throw new Error(`No checkpoint #${params.seq} for workspace ${repo.ws}.`);
  } else {
    checkpoint = checkpoints.at(-1);
    if (!checkpoint) throw new Error(`No checkpoints recorded for workspace ${repo.ws}.`);
  }

  const untrackedBefore = await listUntracked(g, repo.cwd);
  const changedFiles = lines(await g.must(repo.cwd, ["diff", "--name-only", "HEAD", checkpoint.ref]));

  if (params.hard) {
    await g.must(repo.cwd, ["reset", "--hard", checkpoint.ref]);
  } else {
    // Restore tracked files (index + working tree) to the checkpoint without
    // moving HEAD; untracked files are left in place by design.
    await g.must(repo.cwd, ["read-tree", "--reset", "-u", checkpoint.ref]);
  }

  const untrackedRemaining = (await listUntracked(g, repo.cwd)).filter((file) => !untrackedBefore.includes(file));
  return { checkpoint, mode: params.hard ? "hard" : "restore", changedFiles, untrackedRemaining };
}

// ---------------------------------------------------------------------------
// workspace_list
// ---------------------------------------------------------------------------

interface WorkspaceSummary {
  ws: string;
  base?: string;
  checkpoints: number[];
  merges: Array<{ seq: number; reverted: boolean }>;
}

async function performList(g: GitRunner, cwd: string): Promise<{ text: string; details: Record<string, unknown> }> {
  const repo = await resolveRepoContext(g, cwd);

  const baseByWorkspace = new Map<string, string>();
  const baseOut = await g.must(repo.mainRepo, ["for-each-ref", "--format=%(refname)", "refs/pi/workspaces/"]);
  for (const name of lines(baseOut)) {
    const ws = name.split("/")[3];
    if (!ws) continue;
    const symbolic = await g.run(repo.mainRepo, ["symbolic-ref", "--quiet", "--short", name]);
    baseByWorkspace.set(ws, symbolic.code === 0 ? symbolic.stdout.trim() : "(detached)");
  }

  const workspaces = new Map<string, WorkspaceSummary>();
  const entryFor = (ws: string): WorkspaceSummary => {
    const existing = workspaces.get(ws);
    if (existing) return existing;
    const created: WorkspaceSummary = { ws, base: baseByWorkspace.get(ws), checkpoints: [], merges: [] };
    workspaces.set(ws, created);
    return created;
  };

  for (const { name } of await listRefs(g, repo.mainRepo, "refs/pi/checkpoints")) {
    const parts = name.split("/");
    const ws = parts[3];
    const seq = Number(parts.at(-1));
    if (ws && Number.isInteger(seq)) entryFor(ws).checkpoints.push(seq);
  }
  for (const { name } of await listRefs(g, repo.mainRepo, "refs/pi/merges")) {
    const parts = name.split("/");
    const ws = parts[3];
    const seq = Number(parts[4]);
    const kind = parts[5];
    if (!ws || !Number.isInteger(seq) || !kind) continue;
    const entry = entryFor(ws);
    let merge = entry.merges.find((item) => item.seq === seq);
    if (!merge) {
      merge = { seq, reverted: false };
      entry.merges.push(merge);
    }
    if (kind === "revert") merge.reverted = true;
  }
  for (const [ws, base] of baseByWorkspace) if (!workspaces.has(ws)) entryFor(ws).base = base;

  const list = [...workspaces.values()].sort((a, b) => a.ws.localeCompare(b.ws));
  const text = list.length
    ? list
        .map(
          (workspace) =>
            `workspace ${workspace.ws}${workspace.base ? ` (base ${workspace.base})` : ""}` +
            ` checkpoints [${workspace.checkpoints.sort((a, b) => a - b).join(", ")}]` +
            ` merges [${workspace.merges.map((m) => `#${m.seq}${m.reverted ? " reverted" : ""}`).join(", ")}]`,
        )
        .join("\n")
    : "No workspace checkpoints or merges recorded.";
  return { text, details: { current: repo.ws, workspaces: list } };
}

// ---------------------------------------------------------------------------
// workspace_diff
// ---------------------------------------------------------------------------

interface DiffParams {
  target?: string;
  stat?: boolean;
}

const DIFF_OUTPUT_CAP = 12_000;

async function performDiff(g: GitRunner, cwd: string, params: DiffParams): Promise<{ text: string; details: Record<string, unknown> }> {
  const repo = await resolveRepoContext(g, cwd);
  const target = params.target?.trim() || repo.baseBranch;
  if (!target) throw new Error("No base branch; pass `target` explicitly.");
  const targetCommit = await g.must(repo.cwd, ["rev-parse", "--verify", `${target}^{commit}`]);
  const flags = params.stat ? ["--stat"] : [];

  const committed = await g.must(repo.cwd, ["diff", ...flags, `${targetCommit}...HEAD`], 60_000);
  const dirty = (await g.must(repo.cwd, ["status", "--porcelain"])).trim();
  const uncommitted = dirty ? await g.must(repo.cwd, ["diff", ...flags, "HEAD"], 60_000) : "";
  const untracked = await listUntracked(g, repo.cwd);

  const truncate = (value: string) =>
    value.length > DIFF_OUTPUT_CAP ? `${value.slice(0, DIFF_OUTPUT_CAP)}\n… (truncated)` : value;
  const text = [
    `# ${target}...HEAD (committed worktree changes)\n${truncate(committed) || "(none)"}`,
    `# uncommitted worktree changes\n${uncommitted ? truncate(uncommitted) : "(none)"}`,
    untracked.length ? `# untracked files (not in any diff)\n${untracked.map((file) => `  ${file}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { text, details: { target, targetCommit, dirty: Boolean(dirty), untracked } };
}

// ---------------------------------------------------------------------------
// workspace_prune
// ---------------------------------------------------------------------------

interface PruneParams {
  seq?: number;
  refs?: string[];
  all?: boolean;
  gc?: boolean;
}

async function performPrune(g: GitRunner, cwd: string, params: PruneParams): Promise<{ deleted: string[]; gc: boolean }> {
  const repo = await resolveRepoContext(g, cwd);
  const scopedRefs = [
    ...(await listRefs(g, repo.mainRepo, `refs/pi/checkpoints/${repo.ws}`)),
    ...(await listRefs(g, repo.mainRepo, `refs/pi/merges/${repo.ws}`)),
  ];

  let targets: string[];
  if (params.refs?.length) {
    targets = params.refs.map((ref) => {
      const trimmed = ref.trim();
      if (!trimmed.startsWith("refs/pi/")) throw new Error(`Refusing to delete a ref outside refs/pi/: ${ref}`);
      return trimmed;
    });
  } else if (params.all) {
    targets = scopedRefs.map((ref) => ref.name);
  } else if (params.seq !== undefined) {
    targets = scopedRefs
      .filter((ref) => {
        const parts = ref.name.split("/");
        return Number(parts.at(-1)) === params.seq || Number(parts.at(-2)) === params.seq;
      })
      .map((ref) => ref.name);
    if (targets.length === 0) throw new Error(`No checkpoint or merge with seq ${params.seq} for workspace ${repo.ws}.`);
  } else {
    throw new Error("Pass seq, refs, or all=true.");
  }

  for (const ref of targets) await g.must(repo.mainRepo, ["update-ref", "-d", ref]);
  if (params.gc) await g.run(repo.mainRepo, ["gc", "--prune=now"], 120_000);
  return { deleted: targets, gc: Boolean(params.gc) };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function workspaceManager(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workspace_status",
    label: "Workspace Status",
    description:
      "Report the current git workspace: whether the cwd is a linked worktree or the main checkout, its " +
      "branch, the base branch that merges target, whether the base/worktree are dirty, and the recorded " +
      "checkpoints and merges. Call this before checkpointing, merging or reverting.",
    promptSnippet: "Inspect the git workspace, its base branch, checkpoints and merges",
    promptGuidelines: [
      "Call workspace_status first to see the workspace id, base branch, dirty state, and the recorded checkpoints/merges.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      try {
        const result = await buildStatus(makeGit(pi, signal), ctx.cwd);
        return ok(result.text, result.details);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_checkpoint",
    label: "Workspace Checkpoint",
    description:
      "Create a checkpoint of the current worktree under refs/pi/checkpoints/<workspace>/<n>. The snapshot " +
      "contains tracked changes only (untracked files such as .env or build output are never captured) and " +
      "does not modify the working tree or the real index. workspace_merge creates one of these automatically " +
      "before every merge; use this tool only when you want an extra manual checkpoint.",
    promptSnippet: "Create a tracked-only checkpoint of the worktree before a risky operation",
    promptGuidelines: [
      "Checkpoints capture tracked changes only; untracked files are intentionally not included.",
    ],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "Optional human-readable label for the checkpoint." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const checkpoint = await createCheckpoint(makeGit(pi, signal), ctx.cwd, params.label);
        const text =
          `Checkpoint #${checkpoint.seq} created at ${checkpoint.commit.slice(0, 12)} ` +
          `(${checkpoint.captured ? "tracked working-tree changes" : "no tracked changes; points at HEAD"}).`;
        return ok(text, { ...checkpoint });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_merge",
    label: "Workspace Merge",
    description:
      "Merge the current linked worktree back into the base branch of the local repo using a merge commit " +
      "(git merge --no-ff). Before merging it creates a tracked-only pre-merge checkpoint, checks that the " +
      "base checkout is clean, commits the worktree's tracked and new non-ignored files, and refuses to " +
      "commit sensitive-looking files unless allowSensitive is true. It brings the base branch into the " +
      "worktree first, so the base merge does not conflict; if that sync conflicts it aborts and leaves the " +
      "base unchanged. It never runs git reset on the base. Returns the merge commit on success.",
    promptSnippet: "Merge the worktree branch back into the local repo with a pre-merge checkpoint",
    promptGuidelines: [
      "Review the worktree diff before calling workspace_merge.",
      "workspace_merge is the only supported way to bring worktree work into the base branch.",
      "workspace_merge brings the base branch into the worktree first; if that sync conflicts it aborts and leaves the base untouched, and you resolve the conflict in the worktree before retrying.",
      "workspace_merge never runs git reset on the base branch.",
    ],
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Commit/merge message. A default is generated when omitted." })),
      base: Type.Optional(Type.String({ description: "Override the base branch (default: the main checkout's current branch)." })),
      checkpointLabel: Type.Optional(Type.String({ description: "Label for the pre-merge checkpoint." })),
      allowSensitive: Type.Optional(
        Type.Boolean({ description: "Allow committing files that look sensitive (.env, *.pem, ...). Default false." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const outcome = await performMerge(makeGit(pi, signal), ctx.cwd, params);
        if (!outcome.ok) {
          const conflictText = outcome.conflicts?.length ? `\nConflicts:\n${outcome.conflicts.map((f) => `  ${f}`).join("\n")}` : "";
          return {
            content: [{ type: "text", text: `Merge not completed (${outcome.reason}): ${outcome.message}${conflictText}` }],
            details: { ...outcome },
            isError: true,
          };
        }
        const text =
          `Merged workspace ${outcome.ws} into the base branch as ${outcome.mergeCommit.slice(0, 12)}.\n` +
          `pre-merge checkpoint: #${outcome.checkpoint.seq} (${outcome.checkpoint.commit.slice(0, 12)})\n` +
          `worktree commit: ${outcome.sourceCommit.slice(0, 12)}${outcome.committed ? " (created by this call)" : ""}\n` +
          `base before merge: ${outcome.baseBefore.slice(0, 12)}\n` +
          `To undo: workspace_revert with seq ${outcome.seq}.`;
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_revert",
    label: "Workspace Revert",
    description:
      "Undo a merge that workspace_merge recorded, by running `git revert -m 1 <merge commit>` on the base " +
      "branch. This is the only supported base rollback: it preserves history and never uses git reset. " +
      "Refuses when the base checkout is dirty. Defaults to the latest merge not yet reverted; pass seq or " +
      "mergeCommit to choose a specific one. On conflict it aborts and leaves the base unchanged.",
    promptSnippet: "Undo a recorded merge on the base branch with git revert",
    promptGuidelines: [
      "Use workspace_revert to roll back a bad merge; it only runs git revert -m 1 and never resets history.",
      "workspace_status lists recorded merges and which ones were already reverted.",
    ],
    parameters: Type.Object({
      seq: Type.Optional(Type.Number({ description: "Which recorded merge to revert (see workspace_status)." })),
      mergeCommit: Type.Optional(Type.String({ description: "Explicit merge commit to revert." })),
      base: Type.Optional(Type.String({ description: "Override the base branch." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const outcome = await performRevert(makeGit(pi, signal), ctx.cwd, params);
        if (!outcome.ok) {
          const conflictText = `\nConflicts:\n${outcome.conflicts.map((f) => `  ${f}`).join("\n")}`;
          return {
            content: [{ type: "text", text: `Revert not completed: ${outcome.message}${conflictText}` }],
            details: { ...outcome },
            isError: true,
          };
        }
        const text =
          `Reverted merge ${outcome.mergeCommit.slice(0, 12)} as ${outcome.revertCommit.slice(0, 12)}` +
          `${outcome.seq !== null ? ` (merge seq ${outcome.seq})` : ""}.`;
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_create",
    label: "Workspace Create",
    description:
      "Create a linked git worktree for isolated work and record its base branch as refs/pi/workspaces/<ws>/base. " +
      "By default the worktree lives beside the repo at <repo>-worktrees/<branch>. The branch is created from the " +
      "base branch when it does not exist yet, otherwise it is checked out as-is. Returns the worktree path to " +
      "run the session from.",
    promptSnippet: "Create a linked worktree for isolated work",
    promptGuidelines: [
      "Create a linked worktree before editing when the user wants changes isolated from the local repo.",
      "Run the session from the returned worktree path so edits and checkpoints stay off the base branch.",
    ],
    parameters: Type.Object({
      branch: Type.String({ description: "Branch to check out (created from `base` when it does not exist)." }),
      base: Type.Optional(Type.String({ description: "Base branch to create the worktree from (default: the main checkout's current branch)." })),
      path: Type.Optional(Type.String({ description: "Worktree directory (default: <repo>-worktrees/<branch>)." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const outcome = await performCreate(makeGit(pi, signal), ctx.cwd, params);
        const text =
          `Worktree ready at ${outcome.worktree}\nbranch: ${outcome.branch}${outcome.createdBranch ? " (new)" : " (existing)"}\n` +
          `base: ${outcome.base}\nworkspace: ${outcome.ws}\nRun the session from that path.`;
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_sync",
    label: "Workspace Sync",
    description:
      "Bring the base branch into the current worktree with `git merge --no-ff`, so later merges are conflict-free. " +
      "On conflict it aborts and leaves the worktree and base unchanged, and returns the conflicting files to " +
      "resolve in the worktree.",
    promptSnippet: "Bring the base branch into the worktree (git merge)",
    promptGuidelines: ["Use workspace_sync when the user wants to update a worktree from the base branch without merging back yet."],
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: "Base branch to sync from (default: the recorded/current base)." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const g = makeGit(pi, signal);
        const repo = await resolveRepoContext(g, ctx.cwd, params.base);
        if (!repo.isLinkedWorktree) throw new Error("workspace_sync must run from a linked worktree.");
        const outcome = await syncBaseIntoWorktree(g, repo, params.base?.trim() || repo.baseBranch);
        if (!outcome.ok) {
          return {
            content: [{ type: "text", text: `${outcome.message}\nConflicts:\n${(outcome.conflicts ?? []).map((f) => `  ${f}`).join("\n")}` }],
            details: { ...outcome },
            isError: true,
          };
        }
        const text = outcome.alreadySynced
          ? `Already up to date with ${repo.baseBranch}.`
          : `Synced ${repo.baseBranch} into the worktree as ${outcome.sourceCommit.slice(0, 12)}.`;
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_rollback",
    label: "Workspace Rollback",
    description:
      "Restore the worktree's tracked files to a checkpoint without moving the branch (default), or move the " +
      "worktree branch to the checkpoint with hard=true. Untracked files are never removed. Refuses to run in " +
      "the main checkout.",
    promptSnippet: "Restore the worktree to a checkpoint",
    promptGuidelines: [
      "Use workspace_rollback to discard worktree edits back to a checkpoint; checkpoints are tracked-only, so untracked files stay.",
      "Prefer the default restore mode; hard=true moves the worktree branch and discards later commits.",
    ],
    parameters: Type.Object({
      seq: Type.Optional(Type.Number({ description: "Checkpoint to restore (default: the latest)." })),
      ref: Type.Optional(Type.String({ description: "Explicit checkpoint ref to restore (overrides seq)." })),
      hard: Type.Optional(Type.Boolean({ description: "Move the worktree branch with git reset --hard. Default false." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const outcome = await performRollback(makeGit(pi, signal), ctx.cwd, params);
        const text =
          `Restored to checkpoint ${outcome.checkpoint.seq >= 0 ? `#${outcome.checkpoint.seq}` : outcome.checkpoint.ref} ` +
          `(${outcome.checkpoint.commit.slice(0, 12)}) using ${outcome.mode === "hard" ? "git reset --hard" : "git read-tree --reset -u"}.\n` +
          `tracked files restored: ${outcome.changedFiles.length}\n` +
          (outcome.untrackedRemaining.length
            ? `untracked files left in place: ${outcome.untrackedRemaining.join(", ")}`
            : "untracked files left in place: none");
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_list",
    label: "Workspace List",
    description: "List every recorded workspace (checkpoint/merge refs), its base branch, checkpoint ids and merge ids.",
    promptSnippet: "List recorded workspaces, checkpoints and merges",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      try {
        const result = await performList(makeGit(pi, signal), ctx.cwd);
        return ok(result.text, result.details);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_diff",
    label: "Workspace Diff",
    description:
      "Show the worktree's committed changes since the base (or another target) plus any uncommitted changes. " +
      "Pass stat=true for a file-level summary; output is truncated to keep it small.",
    promptSnippet: "Show the worktree diff against the base or a checkpoint",
    promptGuidelines: ["Review workspace_diff before merging, and when the user asks what changed in the worktree."],
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Branch/ref/commit to diff against (default: the base branch)." })),
      stat: Type.Optional(Type.Boolean({ description: "Show a diffstat instead of the full patch." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await performDiff(makeGit(pi, signal), ctx.cwd, params);
        return ok(result.text, result.details);
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "workspace_prune",
    label: "Workspace Prune",
    description:
      "Delete recorded checkpoint/merge refs for the current workspace: one seq, explicit refs (must start with " +
      "refs/pi/), or all=true. This workspace keeps no ref retention limit, so prune is manual. gc=true also runs " +
      "`git gc --prune=now`.",
    promptSnippet: "Delete recorded checkpoint/merge refs",
    promptGuidelines: ["Use workspace_prune only when the user asks to clean up checkpoints; it deletes refs permanently."],
    parameters: Type.Object({
      seq: Type.Optional(Type.Number({ description: "Delete the checkpoint and merge records with this seq." })),
      refs: Type.Optional(Type.Array(Type.String(), { description: "Explicit refs to delete; each must start with refs/pi/." })),
      all: Type.Optional(Type.Boolean({ description: "Delete all checkpoint/merge refs for this workspace." })),
      gc: Type.Optional(Type.Boolean({ description: "Also run git gc --prune=now after deleting." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const outcome = await performPrune(makeGit(pi, signal), ctx.cwd, params);
        const text =
          outcome.deleted.length
            ? `Deleted ${outcome.deleted.length} ref(s):\n${outcome.deleted.map((ref) => `  ${ref}`).join("\n")}${outcome.gc ? "\nRan git gc --prune=now." : ""}`
            : "Nothing to delete.";
        return ok(text, { ...outcome });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerCommand("workspace", {
    description:
      "Workspace manager: status | create <branch> [base] | sync [base] | checkpoint [label] | diff [target] [--stat] | " +
      "merge [message] | revert [seq] | rollback [seq] [--hard] | list | prune <seq|all>",
    handler: async (args, ctx) => {
      const g = makeGit(pi);
      const tokens = (args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const [sub, ...rest] = tokens;
      const flag = (name: string) => {
        const index = rest.indexOf(name);
        if (index >= 0) rest.splice(index, 1);
        return index >= 0;
      };
      const hard = flag("--hard");
      const stat = flag("--stat");
      let text: string;
      try {
        switch (sub) {
          case undefined:
          case "":
          case "status": {
            text = (await buildStatus(g, ctx.cwd)).text;
            break;
          }
          case "create": {
            const outcome = await performCreate(g, ctx.cwd, { branch: rest[0] ?? "", base: rest[1], path: rest[2] });
            text = `Worktree ready at ${outcome.worktree} (branch ${outcome.branch}, base ${outcome.base}).`;
            break;
          }
          case "sync": {
            const repo = await resolveRepoContext(g, ctx.cwd, rest[0]);
            const outcome = await syncBaseIntoWorktree(g, repo, rest[0] || repo.baseBranch);
            text = outcome.ok
              ? outcome.alreadySynced
                ? `Already up to date with ${repo.baseBranch}.`
                : `Synced ${repo.baseBranch} as ${outcome.sourceCommit.slice(0, 12)}.`
              : outcome.message ?? "sync failed";
            break;
          }
          case "checkpoint": {
            const checkpoint = await createCheckpoint(g, ctx.cwd, rest.join(" ") || undefined);
            text = `Checkpoint #${checkpoint.seq} at ${checkpoint.commit.slice(0, 12)}.`;
            break;
          }
          case "diff": {
            text = (await performDiff(g, ctx.cwd, { target: rest[0], stat })).text;
            break;
          }
          case "merge": {
            const outcome = await performMerge(g, ctx.cwd, { message: rest.join(" ") || undefined });
            text = outcome.ok
              ? `Merged as ${outcome.mergeCommit.slice(0, 12)} (checkpoint #${outcome.checkpoint.seq}).`
              : `${outcome.reason}: ${outcome.message}`;
            break;
          }
          case "revert": {
            const seq = rest[0] && Number.isInteger(Number(rest[0])) ? Number(rest[0]) : undefined;
            const outcome = await performRevert(g, ctx.cwd, { seq });
            text = outcome.ok
              ? `Reverted ${outcome.mergeCommit.slice(0, 12)} as ${outcome.revertCommit.slice(0, 12)}.`
              : outcome.message;
            break;
          }
          case "rollback": {
            const seq = rest[0] && Number.isInteger(Number(rest[0])) ? Number(rest[0]) : undefined;
            const outcome = await performRollback(g, ctx.cwd, { seq, hard });
            text = `Restored to checkpoint ${outcome.checkpoint.seq >= 0 ? `#${outcome.checkpoint.seq}` : outcome.checkpoint.ref} (${outcome.changedFiles.length} tracked file(s)).`;
            break;
          }
          case "list": {
            text = (await performList(g, ctx.cwd)).text;
            break;
          }
          case "prune": {
            const all = rest[0] === "all";
            const seq = !all && rest[0] && Number.isInteger(Number(rest[0])) ? Number(rest[0]) : undefined;
            const outcome = await performPrune(g, ctx.cwd, { seq, all });
            text = outcome.deleted.length ? `Deleted ${outcome.deleted.length} ref(s).` : "Nothing to delete.";
            break;
          }
          default:
            text =
              "Usage: /workspace status | create <branch> [base] | sync [base] | checkpoint [label] | " +
              "diff [target] [--stat] | merge [message] | revert [seq] | rollback [seq] [--hard] | list | prune <seq|all>";
        }
      } catch (error) {
        text = error instanceof Error ? error.message : String(error);
      }
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
}
