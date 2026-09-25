# `tengu` census

`bun run scripts/verify/tengu-census.ts` classifies every `tengu*` occurrence in
`src/`, `scripts/`, `docs/`, `.claudin/rules/` and the root markdown files by the
**role** the occurrence plays.

The census exists because `tengu_` was not one thing, and a removal pass that
treated it as one thing either left dead weight behind or silently changed
behaviour. Upstream uses the same prefix for an analytics event name and for a
remote feature-flag key. In this fork the event names were deleted first (with
the analytics sink), and the flag keys after them, each inlined to the value it
already resolved to — [gate-audit.md](gate-audit.md) is the ledger of where
every key went.

**`src/` now holds zero occurrences**, and `tengu-census.test.ts` fails if one
comes back. What remains elsewhere is prose about the removal, the census's own
test fixtures, `scripts/migrations/strip-analytics/` (the codemod that deleted
the events, which imports this script's `scanRegions`) and recorded bench
answers.

## Buckets

| Bucket | What it is |
|---|---|
| `event` | 1st argument of `logEvent`/`logEventAsync` |
| `gate` | argument of `getFeatureValue_*`, `checkStatsigFeatureGate_*`, `checkGate_*`, `getDynamicConfig_*`, `checkSecurityRestrictionGate` |
| `indirect` | a `tengu_` name reached another way — a const, an array element, an object key, a regex pattern |
| `doc` | inside a comment or a `.md` file |
| `unclassified` | the scanner could not place it — **must stay at zero**, or a removal pass driven by the census misses whatever hid there |

Occurrences in `*.test.ts(x)` and `__fixtures__/` carry `fixture: true`, which
keeps a test's own synthetic key out of the gate work list.

## Counts

```
2026-09-15, before the cleanup    1654 occurrences across 425 files
                                  event 1018 · gate 155 · indirect 286 · doc 195
2026-09-25, after the gate removal ~260 occurrences across 24 files, 0 in src/
                                  event 35 · gate 7 · indirect 60 · doc ~160
```

None of the surviving `event`, `gate` and `indirect` hits is a live read: they
are the test fixtures of this script and of `strip-analytics`, recorded answers
in `scripts/bench/ab/read-outline-pivot-ab*.json`, this census's own suite path
in `scripts/verify/test-floor.ts`, and a banned name in
`scripts/verify/verify-no-phone-home.ts`. The `doc` count is mostly this
directory and the rules describing the removal.

## How the classification is decided

A regex alone cannot answer "is this inside a comment?", and that answer decides
two of the five buckets. So the script first classifies **every character** of a
file as code / comment / string / regex (`scanRegions`), then overlays the two
call-shape regexes.

Three cases the character scanner has to get right, each pinned by a test in
`tengu-census.test.ts`:

- **A division is not a regex opener.** `total / count` must not swallow the rest
  of the line as a pattern.
- **An apostrophe in prose does not open a string.** A single or double quote
  never spans a newline, so the scan bails at `\n`; without that, one `it's` in a
  comment would mark the remainder of the file as a string literal.
- **A character class hides the terminating slash.** `/[/]x/` ends at the third
  slash, not the second.
