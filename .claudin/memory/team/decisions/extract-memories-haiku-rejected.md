---
name: extract-memories-haiku-rejected
description: Background memory extraction stays a fork on the session's model — a fresh Haiku 5.5 agent cost 92–94% less per extraction but was judged not worth it on 2026-10-10; CLAUDIN_EXTRACT_MEMORIES_MODEL stays opt-in, the bench stays
type: project
scope: src/memory/extract/extractMemories.ts
impact: rejected
---

**Decision:** The extraction agent (`extractMemories.ts`) keeps running as a
fork of the main loop, on the session's model and effort. Running it as a
fresh agent on Haiku 5.5 was measured and rejected by the user on 2026-10-10.
`CLAUDIN_EXTRACT_MEMORIES_MODEL` / `CLAUDIN_EXTRACT_MEMORIES_EFFORT` stay as
opt-in experiment switches, not a setting.

**Why:** the saving is small in absolute terms and each cheap arm brought a
cost of its own. On the fork one extraction costs ~$0.155 (Opus 5.5 at
medium, a ~30k-token conversation, 88% of it read from the main loop's
cache), and it fires once every 15 eligible turns — about a cent a turn.
Haiku at `high` ($0.009) saved no user-profile memory at all in 2 of 15 runs
(the fork: 0 of 35). Haiku at `xhigh` ($0.013) matched the fork 75/75, but at
53s a request against 25s — ~2.5 min in the background per extraction.

**What changes for a teammate:** nothing by default. The A/B re-runs with
`scripts/bench/ab/extract-memories-ab.ts` (records one conversation once,
resumes it per arm, grades the memories from disk, prices the extraction's
requests off the wire proxy; `--variant` adds an arm, `--recording` reuses
one). `CLAUDIN_EXTRACT_MEMORIES_HEADLESS=1` lets a `-p` run extract, and wait
up to 5 minutes for it.

**Rejected:** Haiku at high (failed the pre-registered quality gate); Haiku at
xhigh as the Anthropic default (quality equal, latency doubled, ~1¢/turn
saved); effort "one level above the main loop" (ties memory quality to the
session's effort, and there is no level above max).

**Evidence:** runs `/tmp/extract-memories-ab/20261010-204526` (base, placebo,
haiku), `…-204957` (10 more base and haiku), `…-211240` (haiku at xhigh, 15);
the numbers are in the bench header. Limits: one conversation, on which the
fork scores 100% — it shows parity, not superiority — and the fresh agent's
cut to "messages since the last extraction" never bit at that size.
