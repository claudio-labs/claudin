# `tengu` census

`bun run scripts/verify/tengu-census.ts` classifies every `tengu*` occurrence in
`src/`, `scripts/`, `docs/`, `.claudin/rules/` and the root markdown files by the
**role** the occurrence plays.

The census exists because `tengu_` is not one thing, and a removal pass that
treats it as one thing either leaves dead weight behind or silently changes
behaviour. Upstream uses the same prefix for an analytics event name and for a
remote feature-flag key, and in this fork those two have opposite fates: the
event name goes nowhere, while the flag key is the thing a user writes in
`~/.claudin/feature-flags.json`.

## Buckets

| Bucket | What it is | Fate in this fork |
|---|---|---|
| `event` | 1st argument of `logEvent`/`logEventAsync` | **Dead.** The destination is an empty function — `scripts/build/no-telemetry-plugin.ts` stubs `src/platform/analytics/index` to `export function logEvent() {}`. `scripts/build/build.ts` already blanks the literal in the bundle for the same reason. |
| `gate` | argument of `getFeatureValue_*`, `checkStatsigFeatureGate_*`, `checkGate_*`, `getDynamicConfig_*`, `checkSecurityRestrictionGate` | **Live as a key** — resolution is `~/.claudin/feature-flags.json` > `_openBuildDefaults` > the call site's `defaultValue`. Whether the branch it opens *works* is a separate question, answered in [gate-audit.md](gate-audit.md). |
| `indirect` | a `tengu_` name reached another way — a const, an array element, an object key, a regex pattern | **Needs human eyes.** The build's rewrite deliberately skips these: a regex cannot tell an event constant from a gate constant, and blanking a gate key would change which default resolves. |
| `doc` | inside a comment or a `.md` file | Prose. The largest single cluster is the ~100-key catalog in `no-telemetry-plugin.ts`, which declares itself "reference only" and has never been verified against the tree. |
| `unclassified` | the scanner could not place it | **Must stay at zero.** A non-zero count means the scanner has a blind spot, so any removal pass driven by this census would miss whatever hid in it. |

Occurrences in `*.test.ts(x)` and `__fixtures__/` are counted but carry
`fixture: true`, which keeps a test's own synthetic key out of the gate work
list.

## Baseline — 2026-09-15, before the cleanup

```
tengu census — 1654 occurrences across 425 files

  event          1018  (290 files)
  gate            155  (98 files)
  indirect        286  (65 files)
  doc             195  (133 files)
  unclassified      0  (0 files)

  distinct gate keys: 91 (test fixtures excluded)
```

`--gates` prints the 91 keys with every call site, which is the work list for
the gate audit. `--json` dumps every occurrence for scripting.

## How the classification is decided

A regex alone cannot answer "is this inside a comment?", and that answer decides
two of the five buckets. So the script first classifies **every character** of a
file as code / comment / string / regex (`scanRegions`), then overlays the two
call-shape regexes — the event one copied from `build.ts` so the two agree on
what an event name is.

Three cases the character scanner has to get right, each pinned by a test in
`tengu-census.test.ts`:

- **A division is not a regex opener.** `total / count` must not swallow the rest
  of the line as a pattern.
- **An apostrophe in prose does not open a string.** A single or double quote
  never spans a newline, so the scan bails at `\n`; without that, one `it's` in a
  comment would mark the remainder of the file as a string literal.
- **A character class hides the terminating slash.** `/[/]x/` ends at the third
  slash, not the second.
