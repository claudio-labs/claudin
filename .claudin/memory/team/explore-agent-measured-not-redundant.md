---
name: explore-agent-measured-not-redundant
description: Explore is NOT obsoleted by Glob/outline (measured 2026-08-16); the waste was the report format, fixed by an output contract — baselines and the bench that reproduces them
type: project
---

The hypothesis "the Explore sub-agent is redundant now that we have Glob and
Read outline" was tested against 99 local sessions / 387 Agent calls / 91 Explore
calls on **2026-08-16** and **rejected on data**. Do not re-open it without new
numbers.

**Demand.** All 91 Explore prompts were read and bucketed by hand. Of the 77
organic calls (11 were bench fixtures, 3 transcript-mining), **72 (93.5%) are
multi-hop**. LOCATE-SYMBOL and READ-ONE-THING are **zero**; only 5 are
LOCATE-FILE. Glob is 102 of Explore's ~2650 internal tool calls (Read 1188, Grep
807, Bash 547) — it is a fan-out reader, not a locator, so Glob was never its
substitute.

**What it actually buys.** Median 82,355 raw chars consumed inside vs 6,483
returned = **13.2x compression**; across the 77 organic calls, 6.53M chars
(~1.63M tokens) never entered the parent's context. Deleting the agent would
have traded that for a 3.6% problem.

**The real defect** was that `getExploreSystemPrompt()` only asked to "report
your findings clearly" while `FileReadTool/prompt.ts` promised the parent it
"returns excerpts in one turn" — so 29% of calls were followed by a FULL re-read
of a file the report already covered. Fixed by giving Explore a `## Required
Output` contract (`path:line` anchor + verbatim excerpt + a mandatory
"Not found / not checked" section) and a reading order (outline → symbol →
offset/limit → full), replicated into the `Plan` and `Code` agents.

**Baselines to beat**, all reproduced by
`bun scripts/bench/tokens/measure-explore-redundancy.ts` (supports `--since`
for the post-change arm):

| | baseline 2026-08-16 | direction |
|---|---|---|
| Explore calls with ≥1 FULL re-read of a reported file | 29.4% (25/85) | lower |
| Distinct reported files re-read in full | 3.6% (45/1262) | lower |
| Median compression inside the sub-agent | 13.2x (n=91) | higher |
| Explore's own Reads that are targeted (outline\|symbol) | 22.7% (1365/6024) | higher |

Two traps that cost a re-run while measuring this:

- **The transcript persists each `tool_use` block as its own assistant record
  sharing one `message.id`.** Counting records reports 0% parallel batching;
  group by `message.id` first (the real figure is 78.1%).
- **Metric 4 has two legitimate denominators.** 383 Explore transcripts exist on
  disk but only 91 link to a main-chain call — most are spawned by *other*
  agents. The rate is 22.7% over all transcripts and 14.2% over linked runs;
  quoting one against the other invents an 8.5pp change. "Targeted" also means
  `outline|symbol` only — widening it to include `offset/limit` gives 62.9%.

The main chain is the worse offender (**7.2%** of its Reads are targeted, vs
Explore's 22.7%) and was deliberately left out of that change, to keep the A/B
readable. That is the open follow-up. See also
[[dev-tooling-token-roadmap]] and [[outline-blind-to-nested-members]].
