---
name: feature-usage-census-2026-09-16
description: Read outline/symbol + Bash outputFilter validation over 2026-09-14..16 (31 active sessions, 4,261 tool calls) — outline+symbol 100% success at 13.1% of Reads, filter 62% line savings, zero failure modes
type: project
---

Measured 2026-09-16 by request ("validar read outline, symbol, bash
outputfilter"), ad-hoc script (not the `feature-usage-census.ts` lane — this
one filtered by **internal message timestamps** `>= 2026-09-14`, not file
mtime, which is the correct window: 159 files in the project dir all carry
recent mtimes from resume-touching, but only **31 sessions were actually
active** Mon–Wed). 4,261 tool calls, deduped by `tool_use.id` per
[[session-corpus-census-inflation]].

**Read (1,226 calls).** range 64.1%, default 18.0%, **outline 6.7% (82)**,
**symbol 6.4% (79)**, full(explicit) 4.7%. Outcomes: **82/82 outlines returned
usable content** (≥5 symbol lines, median ~23) and **79/79 symbols resolved**
— zero empty outlines, zero symbol misses in the window. The two misses seen
in the raw scan (`## Transcript bench @ README.md`, `consumeExecutionPrefix @
registry.ts`) both predate Monday. Outline+symbol combined is **13.1% of
Reads, up from ~8%** in the 09-14..15 census
([[feature-usage-census-2026-09-15]]) — and symbol= alone jumped 0.6% → 6.4%
(13 → 79 calls), the exact surface that census declared "effectively unused".

**Bash outputFilter (732 calls).** 102 results (13.9%) carried the
`<bash-output-filtered>` marker — same rate as the prior census. **Aggregate
3,640 → 1,384 lines = 62% saved; per-result median 77%** (prior: 58%). Zero
0%-reduction markers, zero negative reductions — the floor held everywhere it
fired. Most-filtered shapes unchanged: `bun run smoke|build|test:floor |
tail`, `verify:rules`, `deadcode:ci`.

**Verdict.** All three features are healthy and paying: outline/symbol at 100%
success over 161 calls, filter cutting ~62% of lines where it acts. None of
the known failure modes (empty outline, symbol miss, negative reduction,
0%-marker) appeared. The prior census's open levers (floor-cap re-ask rate,
`head_limit: 0` pivot bypass, ISO-date `groupMatchLines` guard) were NOT
re-measured — this run only validated the three asked-about lanes.

**How to apply:** for trend numbers cite this and
[[feature-usage-census-2026-09-15]] together — same dedupe rule, different
windowing (message timestamp vs mtime). If this validation becomes recurring,
promote the ad-hoc script into `scripts/bench/tokens/`; the user floated that
and has not decided.
