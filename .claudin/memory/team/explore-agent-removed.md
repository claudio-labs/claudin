---
name: explore-agent-removed
description: The built-in Explore agent was REMOVED on 2026-08-18 — what it was measured to be worth, what replaced it, and the bench that still reproduces the old numbers
type: project
---

**The built-in `Explore` sub-agent no longer exists** (removed 2026-08-18, branch
`refactor/remove-explore-agent`). `Plan` stayed. The replacement announced in the
prompts is a **fork** — `Agent` with no `subagent_type`.

This file used to argue the opposite, and the argument was not refuted — it was
overruled. Both halves are recorded here because the numbers still describe what
the removal costs.

## What it was measured to be worth (2026-08-16, 99 sessions / 91 Explore calls)

- **93.5% multi-hop.** Of 77 organic calls, 72 needed several dependent searches.
  LOCATE-SYMBOL and READ-ONE-THING were **zero**; only 5 were LOCATE-FILE. Glob
  was 102 of its ~2650 internal tool calls (Read 1188, Grep 807, Bash 547) — it
  was a fan-out reader, never a locator, so "Glob replaced it" was false.
- **13.2x median compression** (82,355 raw chars consumed inside vs 6,483
  returned). Across the 77 organic calls, 6.53M chars (~1.63M tokens) never
  entered the parent's context.
- A fork does NOT reproduce that: it **inherits** the parent's context. What it
  keeps out is the fan-out it performs, not the parent's own prefix.

## What actually prompted the removal, and what it was

A session measured on 2026-08-18 (`84a654c9`, legendarr) showed the parent
re-reading **17 of the 35 files** Explore had already read (71,515 B; 12 calls
byte-identical). The cause was **not** the agent: `dispatchArray` in
`src/agent/tools/toolResultSummarizer.ts` ran `maybeCodeOutline()` on the report
before `summarizeAgentOutput()`, so a 26 KB prose report became **683 bytes** of
symbol signatures and the parent immediately Read the 28 KB spill file back.
That is fixed in the same change, and the fix is **tool-scoped**: no Agent result
is ever code-outlined, MCP keeps its arm. See
`src/agent/toolResultCodeOutline.test.ts` → `agent reports are never outlined`.

## Still reproducible

`bun scripts/bench/tokens/measure-explore-redundancy.ts` was kept on purpose. It
parses historical transcripts, so the 2026-08-16 baselines below are still
measurable from disk if the decision is ever revisited:

| | baseline 2026-08-16 |
|---|---|
| Explore calls with ≥1 FULL re-read of a reported file | 29.4% (25/85) |
| Distinct reported files re-read in full | 3.6% (45/1262) |
| Median compression inside the sub-agent | 13.2x (n=91) |
| Explore's own Reads that are targeted (outline\|symbol) | 22.7% (1365/6024) |

Two traps that cost a re-run while measuring this:

- **The transcript persists each `tool_use` block as its own assistant record
  sharing one `message.id`.** Counting records reports 0% parallel batching;
  group by `message.id` first (the real figure is 78.1%).
- **Metric 4 has two legitimate denominators.** 383 Explore transcripts exist on
  disk but only 91 link to a main-chain call — most were spawned by *other*
  agents. The rate is 22.7% over all transcripts and 14.2% over linked runs;
  quoting one against the other invents an 8.5pp change. "Targeted" also means
  `outline|symbol` only — widening it to include `offset/limit` gives 62.9%.

The main chain was and is the worse offender (**7.2%** of its Reads are
targeted, vs Explore's 22.7%). That is now the only lane left to fix. See also
[[dev-tooling-token-roadmap]] and [[outline-blind-to-nested-members]].

## If you are bringing it back

`src/__tests__/exploreAgentRemoved.test.ts` fails first, by design — it guards
the definition, the quoted agent-type literal across `src/`, the **eight** prompt
sites that named it (most of which shipped ungated, so grepping the registry
would not have found them), and the `BUILTIN_PLAN_AGENT` flag rename. Delete it
in the same commit and put the numbers in the message.
