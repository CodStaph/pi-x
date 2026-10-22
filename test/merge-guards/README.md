# Merge guards

Assertions **about the repository**, not about runtime behaviour. They exist because
this repo is a fork of `agegr/pi-web` that is merged upstream repeatedly, and a merge
that applies cleanly can still be wrong in three ways nothing else catches:

| Direction | What it looks like | How it is guarded |
|---|---|---|
| Resurrection | Code the fork *moved* to another file reappears at its origin (git does not track cross-file moves) | an extraction entry: `origin`, `movedTo`, `movedDefinitions`, `absentFromOrigin` |
| Erosion | A fork change is silently reverted toward upstream | `markers` that must still be present |
| Re-adoption | A region the fork deliberately deleted comes back | `forbiddenMarkers` that must stay absent |

`fork-extractions.test.mjs` is the file that holds them; `scripts/fork-ownership.json`
is the measured counterpart (risk per upstream file, from
`scripts/measure-fork-drift.mjs`), and `scripts/check-ownership-sentinels.mjs` keeps the
two in step (`npm run check:ownership`). All three run in the `ownership` CI job.

## Why these tests read source text

They assert on file contents, which normally means a test is coupled to an
implementation. Here the source *is* the artifact under protection: no runtime
behaviour can tell you that a paragraph of code moved back into an upstream file,
because both copies behave the same until upstream edits one of them. Keep them
regex-and-marker based, and keep the failure message telling the next person to
*re-apply the fork change* rather than to delete the assertion.

## Rules for a new guard

1. Put it in `fork-extractions.test.mjs`, not next to the feature it protects.
2. Prefer a marker that only the fork produces (a fork-only class name, a
   `composer-*` selector, a component that does not exist upstream) over something
   generic that a refactor would rename anyway.
3. For a deletion, use `forbiddenMarkers` (and a comment saying why it was removed).
4. For a move, add an extraction entry so the origin is also checked.
5. If the file is `high` risk in `scripts/fork-ownership.json`, the guard is
   mandatory: `npm run check:ownership` fails without it. Two exemptions exist,
   both requiring a `sentinelReason` in the manifest:
   - `"sentinels": "elsewhere"` — guarded, but by a dedicated suite
     (`hooks/useAgentSession.test.mjs`, `app/api/files/stream-route.test.mjs`,
     `lib/i18n/registry.test.mjs`); the reason names it;
   - `"sentinels": "none"` — no guard is warranted (pure data).

## What does not belong here

Behaviour tests (a reducer, a parser, a component rendering) stay next to the code
they test. A test that needs a browser, a session or the SDK is not a merge guard —
`test/merge-guards/` must stay runnable with `node --test` and nothing else.
