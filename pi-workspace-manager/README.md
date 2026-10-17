# pi-workspace-manager

A Pi extension (no UI) that gives the agent a **checkpoint → merge → revert**
workflow over git worktrees. The agent calls it through natural language; the
tools are registered with `pi.registerTool`.

## Model

- **base** — the local repo's normal checkout and branch.
- **worktree** — a linked `git worktree` where the agent/user edits.
- **checkpoint** — a tracked-only snapshot under an independent ref namespace
  (`refs/pi/checkpoints/<ws>/<n>`), created automatically before every merge.
- **merge** — `git merge --no-ff` of the worktree branch into the base, always
  a merge commit.
- **revert** — the only base rollback: `git revert -m 1 <merge commit>`.
  `git reset --hard` is never used on the base.

## Install

```
pi install ./pi-workspace-manager          # local
pi install npm:pi-workspace-manager        # if published
pi install git:github.com/<you>/pi-workspace-manager
```

Or try it for one run: `pi -e ./pi-workspace-manager`.

## Tools

| Tool | Purpose |
|---|---|
| `workspace_status` | Repo/worktree/base branch, dirty state, checkpoints and recorded merges. |
| `workspace_create` | Create a linked worktree (`git worktree add -b`) and record `refs/pi/workspaces/<ws>/base`. |
| `workspace_sync` | Bring the base branch into the worktree (`git merge --no-ff`); aborts on conflict. |
| `workspace_checkpoint` | Manual tracked-only checkpoint (also created automatically before merges). |
| `workspace_diff` | Committed changes since the base/another target, uncommitted changes, and untracked files. |
| `workspace_merge` | Pre-merge checkpoint → commit the worktree → sync the base in → `merge --no-ff` into the base. |
| `workspace_revert` | `git revert -m 1` a recorded merge on the base. |
| `workspace_rollback` | Restore the worktree's tracked files to a checkpoint (or move the branch with `hard=true`). |
| `workspace_list` | List every recorded workspace, its base, checkpoint ids and merge ids. |
| `workspace_prune` | Delete checkpoint/merge refs (`seq`, explicit `refs`, or `all`), optionally `git gc`. |

A `/workspace` command exposes the same operations to the TUI:
`/workspace status | create <branch> [base] | sync [base] | checkpoint [label] |
diff [target] [--stat] | merge [message] | revert [seq] |
rollback [seq] [--hard] | list | prune <seq|all>`.

## Typical flow

1. Create the worktree through the tool (or pi-web's worktree switcher):
   `workspace_create({ branch: "feature", base: "main" })`.
2. Run Pi with the returned worktree path as the session cwd and edit there.
3. Optionally `workspace_sync` / `workspace_diff` to review.
4. Ask the agent to merge, or call `workspace_merge`. It:
   - snapshots tracked changes into a pre-merge checkpoint;
   - commits tracked + new non-ignored files (refusing sensitive-looking ones);
   - merges the base into the worktree first (conflicts are resolved in the
     worktree; the base is never touched on conflict);
   - merges the worktree into the base with `--no-ff`.
5. If the merge turned out wrong, call `workspace_revert` (optionally with the
   merge `seq` from `workspace_status`); to discard worktree edits instead, use
   `workspace_rollback`.

## Refs written

```
refs/pi/workspaces/<ws>/base                     # symbolic ref to the base branch
refs/pi/checkpoints/<ws>/<n>
refs/pi/merges/<ws>/<n>/base
refs/pi/merges/<ws>/<n>/source
refs/pi/merges/<ws>/<n>/head
refs/pi/merges/<ws>/<n>/revert
```

`<ws>` is a hash of the shared git dir plus the worktree branch, so it is
stable and derivable from the cwd. There is deliberately no retention cap;
use `workspace_prune` (or delete refs manually) to reclaim space.

## Safety

- All git commands run via `pi.exec("git", argv)` — never through a shell.
- The base must be clean before a merge or revert.
- Sensitive-looking untracked/modified files (`.env`, `*.pem`, `id_rsa*`, …)
  are refused unless `allowSensitive` is true; `.env.example`-style templates
  are allowed.
- Checkpoints contain tracked changes only; untracked files are never captured.
- Conflicts abort and leave the base unchanged.

## Test

```
node --experimental-strip-types --test test/workspace-manager.test.mjs
```

The test drives the tools against a real temporary git repo and a linked
worktree (create, sync, merge, revert, rollback, diff, list, prune,
sensitive-file refusal, base auto-sync, sync conflict).
