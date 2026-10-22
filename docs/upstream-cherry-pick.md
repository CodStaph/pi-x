# Upstream cherry-pick candidates (route C)

Status: **in progress.** This replaces the full-sync plan for v0.12.2; see
"why not a merge" below. Ported commits land on `main` as normal commits, each
one carrying its upstream sha.

## Why not a merge

`git merge v0.12.2` into `de2d8ef` produced **99 conflicting files** (78 both
modified, 13 deleted upstream but modified here, 6 the reverse, 2 added on both
sides). The five runtime files alone carry 56 conflict hunks
(`lib/rpc-manager.ts` 9, `hooks/useAgentSession.ts` 10,
`components/ChatInput.tsx` 11, `components/AppShell.tsx` 25,
`lib/session-reader.ts` 1).

Two facts changed the calculus:

1. **The fork is ahead on the SDK**: upstream v0.12.2 pins pi 1.2.0, this fork
   runs 1.3.0. A merge would *downgrade* the dependency and force us to
   hand-restore it, while the upstream work in 0.11/0.12 is pi-web's own
   (transcript notices, catalog first message, subagent codemode/MCP extensions,
   signature stripping) rather than SDK adaptation.
2. Most of what 0.11/0.12 adds is UI the fork has already declined
   (ChatMinimap, SessionSearch, sidebar explorer), so a full merge would
   re-introduce conflicts that `test/merge-guards/` exists to catch.

Route C keeps the useful fixes at zero merge surface.

## Runbook for one commit

```bash
git cherry-pick -n <sha>            # no commit yet, review the conflicts
# resolve: keep both sides where they touch different concerns, and record the
# reasoning in the commit message (the next merge will read it)
node --experimental-strip-types --test <touched tests>
node node_modules/typescript/bin/tsc --noEmit
npm test && npm run lint
git commit                          # message: upstream subject + "Cherry-picked from ..." + conflict notes
```

A Windows-only failure in a POSIX-facing test is fixed with
`{ skip: process.platform === "win32" ? "…" : false }`, not by weakening the
assertion.

## Ported

| upstream | landed as | note |
|---|---|---|
| `cf3ebfb` fix(security): rotate preview-mode secrets at startup | `23929fb` | closed a proxy bypass (`x-prerender-revalidate` skipped `proxy.ts`). Conflicts: kept the fork's `network-exposure-warning` module instead of upstream's inline copy; skipped the read-only-directory test on Windows. |

## Candidates

"drifted" counts files the manifest already tracks (a merge surface); a high-risk
hit means the port needs care, not that it is wrong. `feat`, `style`, `docs` and
`chore` commits are not listed — most of them are declined UI or dependency work
the fork already has.

## Security

| sha | date | subject | files | drifted |
|---|---|---|---|---|
| `cf3ebfb` | 2026-10-08 | fix(security): rotate preview-mode secrets at startup to close proxy auth bypass | 3 | 0 |

## Data integrity

| sha | date | subject | files | drifted |
|---|---|---|---|---|
| `5fd1e67` | 2026-10-09 | fix(chat): retry banner, context %, t/s and history window after session switches (#988, #1031, #877, #896) (#1114) | 10 | 3 (3 high) |

## Crash / hang / resource

| sha | date | subject | files | drifted |
|---|---|---|---|---|
| `ac54e01` | 2026-10-15 | fix(files): find a changed file's own repository for its diff (#1236) | 2 | 0 |
| `bf0730c` | 2026-10-15 | fix(files): stop overflowing panel tabs from being clipped (#1225) (#1242) | 3 | 1 |
| `e2ea7da` | 2026-10-07 | fix(markdown): preserve code backgrounds across theme changes (#1060) | 5 | 1 |

## Performance

| sha | date | subject | files | drifted |
|---|---|---|---|---|
| `1a94341` | 2026-10-15 | perf(sessions): rescan only the appended tail of a growing session file (#1259) (#1264) | 4 | 0 |
| `8f3a71e` | 2026-10-15 | perf(sessions): omit provider signatures from browser payloads (#1193) | 12 | 1 |
| `feb40f6` | 2026-10-14 | perf(settings): stop reloading every extension per provider and skills request (#1226) | 19 | 1 (1 high) |
| `3d1ac41` | 2026-10-14 | perf(chat): render long expanded thinking in pieces (#1196) | 8 | 1 (1 high) |
| `e8d91ef` | 2026-10-11 | perf(chat): re-render only the streaming reply per chunk (#1191) | 10 | 3 (3 high) |
| `046bc67` | 2026-10-11 | perf(chat): load Prism languages on demand (#1183) | 8 | 2 (1 high) |
| `b2b6a45` | 2026-10-11 | perf: image caching, subagent relation cache, view-cache sizing, deferred code highlighting (#1181) | 12 | 3 (1 high) |
| `b73fdeb` | 2026-10-11 | perf(sessions): rebuild the list once per finished run (#1177) | 5 | 2 (2 high) |
| `a952ed5` | 2026-10-11 | perf: streaming markdown, session list payload, push title, SSE image echo (#1176) | 15 | 3 (1 high) |
| `6425d0d` | 2026-10-09 | perf(server): start the pi SDK import at startup, not on the first request (#964) (#1117) | 2 | 0 |
| `80cd55e` | 2026-10-07 | perf(sidebar): replace SMIL spinner with compositor-friendly CSS animations (#1042) | 2 | 1 (1 high) |

## Remaining fixes (first 20 of 57, least entangled first)

| sha | date | subject | files | drifted |
|---|---|---|---|---|
| `8b9a084` | 2026-10-15 | fix(http): give connect attempts the CLI's two-second window (#1261) | 1 | 0 |
| `6742182` | 2026-10-09 | fix(build): keep .claude worktrees out of Tailwind's source scan | 1 | 0 |
| `f722a5d` | 2026-10-09 | fix(settings): scroll the general page across the dialog's full width | 1 | 0 |
| `84aa8d7` | 2026-10-15 | fix(worktree): focus the branch field when the create form swaps in over a filtered list (#1203) | 2 | 0 |
| `4c0077b` | 2026-10-15 | fix(http): keep proxied HTTP origins on CONNECT tunnels so httpIdleTimeoutMs applies | 2 | 0 |
| `37d4045` | 2026-10-08 | fix(sw): don't hold static responses behind the cache write (#1089) | 2 | 0 |
| `81e5b03` | 2026-10-07 | fix(markdown): wrap long table cells without squeezing wide tables (#1056) | 2 | 0 |
| `b8ef31e` | 2026-10-15 | fix(tools): keep bash off when defaultTools leaves it out (#1235) (#1245) | 3 | 0 |
| `c5555cd` | 2026-10-15 | fix(subagents): keep a settled run findable by the id it was given (#1198) | 3 | 0 |
| `341ada5` | 2026-10-14 | fix(subagents): refuse to resume a subagent whose folder is gone (#1202) | 3 | 0 |
| `5abdee3` | 2026-10-11 | fix(cli): exit when the event loop drains after the server probe (#1174) (#1179) | 3 | 0 |
| `650d7a3` | 2026-10-09 | fix(http): apply settings' httpIdleTimeoutMs to the Web UI (#1127) | 3 | 0 |
| `6f2b4f0` | 2026-10-04 | fix(subagents): reject unsupported resume option overrides | 3 | 0 |
| `7a416ce` | 2026-10-11 | fix(audio): suspend the completion-sound context while idle (#1157) (#1178) | 4 | 0 |
| `496611c` | 2026-10-07 | fix(subagents): keep turn limits and terminal outcomes at the SDK boundary (#1093) | 4 | 0 |
| `fb6df88` | 2026-10-09 | fix(subagents): let the profile decide the spawn parameters (#1138) | 7 | 0 |
| `0368401` | 2026-10-14 | fix(subagents): size input_files by the child model's context window (#1199) | 8 | 0 |
| `ce5c08c` | 2026-10-08 | fix(sidebar): keep the drag ghost clear of the drop line | 8 | 0 |
| `c713fca` | 2026-10-15 | fix(file-viewer): keep the line-number gutter pinned and ease the code font (#1200) | 2 | 1 (1 high) |
| `3ff7e1d` | 2026-10-11 | fix(terminal): keep input alive when the phone keyboard collapses the panel (#1160) | 2 | 1 |

## Not ported on purpose

- `feat` commits adding `ChatMinimap`, `SessionSearch`, the sidebar explorer pane,
  the second mobile toolbar group and the topbar quick-buttons (`AGENTS.md`,
  "Declined upstream UI stays declined").
- Dependency bumps: the fork is already on pi 1.3.0 / Next 16.3.8.
- The `0.12.x` release commits themselves.

## Keeping this honest

After each batch: `npm run drift` (recorded vs measured risk), `npm run drift:sdk`
(71 / 90 / 25 ratchet), `npm run check:ownership`, `npm run check:docs`.
