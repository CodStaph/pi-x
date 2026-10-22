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
git log -1 --format=%h              # read the landed sha, then add the row below
```

The "landed as" sha can only be filled in *after* the code commit exists; a
guessed sha has been wrong twice now, so this table is updated in a follow-up
commit, never alongside the code.

A Windows-only failure in a POSIX-facing test is fixed with
`{ skip: process.platform === "win32" ? "…" : false }`, not by weakening the
assertion.

## Ported

| upstream | landed as | note |
|---|---|---|
| `cf3ebfb` fix(security): rotate preview-mode secrets at startup | `23929fb` | closed a proxy bypass (`x-prerender-revalidate` skipped `proxy.ts`). Conflicts: kept the fork's `network-exposure-warning` module instead of upstream's inline copy; skipped the read-only-directory test on Windows. |
| `6425d0d` perf(server): start the pi SDK import at startup | `e515054` | auto-merged. Note: `lib/migrations` already imports `getAgentDir`, so the SDK is loaded during register() anyway; the warm-up makes that independent of the accident. Fixing the ratchet's blind spots (lazy imports, root files) raised its baseline to 73 / 92 / 25. |
| `8e602ca` fix(sessions): discover external session files without manual refresh | `b1c2ef9` | scanner series 1/2: filename-only membership check, at most once per second. |
| `1a94341` perf(sessions): rescan only the appended tail of a growing session file | `6ad7260` | scanner series 2/2. Resume points (inode, offset, header+tail hash, running totals); index writes throttled to 5 s. Fork work: `compactionCount` threaded through `ScanTotals`/`foldEntry`/`ResumePoint` (upstream has no such count), `INDEX_FORMAT_VERSION` stays 2 because a resume point is optional. |
| `3ff7e1d` fix(terminal): keep input alive when the phone keyboard collapses the panel | `41a7514` | rows ≥ 1 accepted and clamped to 2 on both sides. |
| `11c2aa2` fix(worktrees): group a bare clone's worktrees under the clone | `80f8f42` | `repoRootFromCommonDir()` walks up to the owning checkout. |
| `a3a158a` fix(models): list models in pi's /model order | `cc23998` | new `orderSelectorModels()`; conflicts needed both test blocks and the fork's `buttonTitle` restored for its aria-label. |
| `37d4045` fix(sw): don't hold static responses behind the cache write | `46c325c` | clean apply; the response no longer waits for the cache write. |
| `8347ea5` fix(markdown): stop clipping two-digit ordered list numbers | `c65a8ae` | adapted: padding rule in `app/native-theme.css`, `MarkdownBody`'s `ol` sets `--ol-marker-digits`. |
| `6d4d6b5` fix(markdown): render emphasis next to CJK punctuation | `2996447` | adds the `remark-cjk-friendly` devDependency (lock updated, tauri pin still passes). |
| `8b9a084` fix(http): give connect attempts the CLI's two-second window | `7931cf4` | clean apply. |
| `4c0077b` fix(http): keep proxied HTTP origins on CONNECT tunnels | `9947cfd` | clean apply; `httpIdleTimeoutMs` now matches tunnelled requests. |
| `650d7a3` fix(http): apply settings' httpIdleTimeoutMs to the Web UI | `be6ad0a` | auto-merged into `instrumentation-node.ts` beside the migrations hook. Windows: the new `defaultAgentDir` test skips `file:///tmp/agent` (no drive letter ⇒ `fileURLToPath` rejects it). |
| `6f2b4f0` fix(subagents): reject resume with new-session options | `94020ca` | clean apply; `model`/`thinking`/`max_turns`/`inherit_context`/`input_files`/`isolation` are refused on resume instead of silently ignored. |
| `81e5b03` fix(markdown): bound table cells so long content wraps | `898d5b9` | adapted: upstream edits `app/globals.css`, which must stay byte-identical here, so the rule lives in `app/native-theme.css`. Its e2e scenario is **not** ported (unverifiable locally, CI logs unreadable). |
| `341ada5` fix(subagents): refuse to resume a subagent whose folder is gone | `ce0065d` | same check as `send()`'s, made in `resume()` because it prompts the SDK session directly. Docs hunk kept ours (it bundles other commits). |
| `b8ef31e` fix(tools): keep the sanitized bash off unless named | `5827f6e` | the fork's `bash` extension lacked `defaultActive: false`, so it came back in every session whatever `defaultTools` left out. Only the test's import block conflicted. |
| `5fd1e67` fix(chat): retry banner / t-s / history window after session switches | `fa7296a` | **partial**: #988, #877, #896 ported; #1031 needs upstream's #1058 `refreshContextUsage` refactor and is dropped. ChatWindow keeps the fork's per-session window memory and adopts the sentinel state beside it. |
| `8f3a71e` perf(sessions): omit provider signatures from browser payloads | `71f40bc` | signature strip runs *before* the fork's `slimToolResultMessage` projection (upstream's separate block would have skipped it), in both the wire and `entryToUiMessage`; non-assistant `message_start` now carries only its role. `isMessageGroupAnchor` left unimported — its users are later v0.12 commits that are not ported. |

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

## Assessed and rejected (route C, first pass)

Three candidates from the table above were examined and dropped. None of them was
a matter of effort — each one fails a different applicability check, which is why
that check comes before the cherry-pick.

| upstream | why it does not apply |
|---|---|
| `1a94341` perf(sessions): rescan only the appended tail | **Depends on earlier v0.11/0.12 refactors.** 513 changed lines against a scanner whose index format was rebuilt upstream (`INDEX_FORMAT_VERSION` 1 there vs 2 here), and the resume logic assumes fields those commits added. Porting it alone yields a half-migrated index. Port the scanner series as a unit, or not at all. |
| `ac54e01` fix(files): find a changed file's own repository for its diff | **The fork's route is not upstream's.** `app/api/git/diff/route.ts` came from `6e0b9d1 feat(explorer): complete quick changes viewer`; upstream's test file never existed here (`git log --diff-filter=D` is empty), so the fix targets a different implementation. |
| `f722a5d` fix(settings): scroll the general page across the dialog's full width | **Already solved differently.** The fork's General tab is a two-column grid above 880px with `max-width: none` (app/native-theme.css), so the scrollbar is already at the dialog edge; upstream's `> * { max-width: 600px }` would squeeze each column. |
| `6742182` fix(build): keep .claude worktrees out of Tailwind's source scan | **Conditional.** The bug needs symlinked `.claude` worktrees (`next build` crashes in a webpack snapshot); this repo has no `.claude` directory, and the fix is a Tailwind `@source not` that can only live in `app/globals.css`, which must stay byte-identical here. Re-check when a `.claude` tree actually exists. |
| `bf0730c` fix(files): stop overflowing panel tabs from being clipped | **Already solved differently.** The fork styles tabs with `.file-tab-bar` in `app/native-theme.css` (100% height, hidden scrollbar) instead of upstream's inline 36px bar; re-adopting upstream's inline styles would undo the CSS extraction, and its test asserts those inline styles. |

## Applicability check (run before `cherry-pick`)

1. **Do the target files exist here, with the same provenance?**
   `git log --oneline -3 -- <path>` — a route that came from a fork commit is a
   different implementation, however similar the filename.
2. **Has the fork already solved the same problem another way?**
   Grep `app/native-theme.css` and `AGENTS.md`'s declined-UI list. A CSS-class
   refactor makes an upstream inline-style fix non-portable, and its test will
   assert the inline style.
3. **Does the commit assume an earlier refactor?**
   Read the diff for fields/constants that do not exist here. A single commit in
   the middle of a series is not portable on its own; take the series or skip it.

## Candidate pool status

After 19 ports and 7 rejections, the automated filter (files exist here, at most
two manifest hits, no high-risk file) is exhausted. **Series porting is the working
answer**: the scanner pair (`8e602ca` + `1a94341`) landed as two commits, the first
of which supplies the imports and tests the second assumes, and neither is usable
alone.

Measured with the series' own bench (`lib/session-list-scanner.bench.mjs`, 2000
synthetic sessions / 137 MiB):

| mode | median |
|---|---|
| SDK full scan | 1161 ms |
| Scanner, no index | 1017 ms |
| Scanner, memory index | 53 ms |
| Scanner, persisted index (new process) | 91 ms |
| **150 MiB session, one appended line** | **2.6 ms** (862.7 ms without resume) |

That last row is the point of the series: a running session's listing used to
re-read its whole file on every append.

Remaining candidates all touch the large runtime files the wrapper split would
rewrite. The next step is either the merge window (stage C2-3/C2-4) or another
deliberate series.

## Not ported on purpose

- `feat` commits adding `ChatMinimap`, `SessionSearch`, the sidebar explorer pane,
  the second mobile toolbar group and the topbar quick-buttons (`AGENTS.md`,
  "Declined upstream UI stays declined").
- Dependency bumps: the fork is already on pi 1.3.0 / Next 16.3.8.
- The `0.12.x` release commits themselves.

## Keeping this honest

After each batch: `npm run drift` (recorded vs measured risk), `npm run drift:sdk`
(73 / 92 / 25 ratchet; raised once for lazy imports and root files), `npm run check:ownership`, `npm run check:docs`.
