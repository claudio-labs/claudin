---
name: feature-usage-census-2026-09-15
description: Bash filter / Grep output modes / Read shape usage measured over 2026-09-14..15 (14 sessions, 7,456 tool calls) — the floor cap's 33% re-ask rate, head_limit=0 on 1 in 5 Greps, symbols mode dead, auto-outline bypassed 1 in 3
type: project
---

Measured 2026-09-15 with `scripts/bench/tokens/feature-usage-census.ts`
(`--since=2026-09-14 --until=2026-09-15`, census session excluded), 14 sessions
/ 67 transcripts / 7,456 tool calls, 55% from sub-agents. Tool-result chars:
Read 52.7%, Grep 26.0%, Bash 7.2%, Git 6.1%.

**Bash filter.** 1,247 calls → 92 redirected (Grep 29, Read 23, RunTests ~13,
Glob 5), 110 errors, 1,044 ran; 143 (13.7%) got a filter marker, median
reduction 58%, ≈422 KB saved on the lane. 85% of what ran is raw, and of the
155 raw results ≥1 KB, 105 are compound — the shape ceiling from
[[bash-filter-shape-wontfix]] again. Two findings the sizing never priced:

- **The floor cap re-ask rate is 33%.** `FLOOR_CAP_LINES = 60` is the
  threshold, but the pipeline keeps `DEFAULT_HEAD_LINES + DEFAULT_TAIL_LINES`
  = 30, so a 61-line output comes back as 30 lines. 85 results were capped
  (ls 18, find 15, grep 11, `bun x.ts` 8, for 5, python3 4); within the next
  3 calls the model re-asked about the same target 28 times (bun scripts 7,
  find 6, grep 4) — each a full round trip against what the cut saved.
  `measure-bash-cap-sizing.test.ts` varied the threshold, never the kept
  count or the re-ask cost. Do not retune the cap without adding both.
- **`groupMatchLines` misreads an ISO date as `path-line-`.** `ls -la
  --time-style=long-iso` came back regrouped (`lines="57/38"`, the `2026-`
  prefix hoisted as a "file"). Zero hits in the 2-day corpus, one live in the
  census session. Guard: decline unless some line split on a COLON.

**Grep.** 1,623 calls; content 85.5%, files_with_matches 7.3%, count 7.2%,
**symbols 1 call**. `head_limit` set on 66%, `path` on 66%. The auto-pivot
fired 15× (5 took the hint, 10 did not re-run). `head_limit: 0` (unlimited,
"use sparingly") is on **316 calls (19.5%) carrying 27% of Grep chars**
(872 KB); it also disables the pivot (`headLimitGiven` is `!== undefined`,
so 0 counts). 72 of the 73 content results over 6 KB had a head_limit set —
the pivot's fence is exactly what lets the large results through.

**Read.** 2,346 calls; range 69.6%, full(default) 19.8%, outline 7.4%,
full(explicit) 2.6% (median 9 KB), **symbol 0.6%** (13 calls). 231 outline
results (173 explicit + 59 auto-pivot). After an explicit outline: 53% no
further read, 38% range, 3% symbol. After an AUTO outline: 54% range, **34%
`view='full'` of the same file** (327 KB across 29 such re-reads), 10% none.
Slice-walks (3+ range reads, no outline first): 158 paths / 782 calls /
1.88 MB — 14 of them contiguous (516 KB); REPL.tsx 60 range reads, prompts.ts
41, config.ts 51. Read right after editing the same path: 109 calls / 168 KB.

**Verdict.** The filter and the outline earn their keep where they fire; the
symbol-MAP surfaces (Grep symbols, Read symbol=, Rename, LSP) are effectively
unused and steering them from the prompt is known inert
([[read-shape-steering-is-cost-neutral]]). The levers with numbers on them are
mechanical: the cap's kept count, `head_limit: 0` as a pivot bypass, and the
ISO-date guard.

**How to apply:** re-run the script for any later window before citing these;
day-by-day ratios held (2026-09-14 alone: filtered 11.4%, re-ask 10/35, auto
outline → full 12/29). Related: [[session-corpus-census-inflation]] for why
the walk dedupes by tool_use id.
