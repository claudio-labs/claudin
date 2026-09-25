---
name: explore-agent-removed
description: The built-in Explore agent was REMOVED on 2026-08-18 and came back OPT-IN on 2026-09-25 (CLAUDIN_EXPLORE_AGENT=1, sonnet, verbatim path:start-end excerpts) — the A/B that gated it, what it was worth in 2026-08, and the bench that reproduces both
type: project
scope: tools/AgentTool
impact: functional
---

## Back, opt-in (2026-09-25)

**Decision:** `Explore` is a built-in again, OFF by default.
`CLAUDIN_EXPLORE_AGENT=1` registers it (`isExploreAgentEnabled`,
`src/tools/AgentTool/builtInAgents.ts`).
- **Tools:** an allowlist of Read/Glob/Grep/Bash/WebFetch/WebSearch, not the old
  denylist.
- **Model:** `sonnet` (user pick), which means the parent's model off a
  Claude-native provider. The caller can pass `model` per call, `inherit`
  included.
- **Runs:** one-shot, no plan dossier (`Explore: 0`).
- **Report:** kept out of the head/tail summarizer
  (`UNSUMMARIZED_AGENT_TYPES`). Its contract: verbatim excerpts under a full
  absolute `path:start-end`, so the parent can Patch or Edit from them.
- **Where it is named:** only when the registry has it — the Agent description's
  research lane and EnterPlanMode's line. Plan mode still does Phase 1 itself.

**Why:** the user asked for a search sub-type whose report comes back in the
shape Write and Patch consume, with a per-call model (cheaper / stronger / same
as the main).

**A/B** (`delegation-steer-ab.ts`, N=5, Opus 5.5 at medium effort, arms
baseline / explore / placebo; run `/tmp/delegation-steer-ab/20260925-032543`).
The bench's pre-registered gates all passed for explore and for the placebo.

| per rep, median [min–max] | baseline | explore | placebo |
|---|---|---|---|
| correct, all reps | 35/35 | 34/35 | 34/35 |
| multi-hop delegated (of 5) | 0 [0–0] | 1 [1–2] SEPARATED | 0 [0–1] |
| main-thread tool calls | 45 [39–48] | 32 [31–37] −29% SEPARATED | 46 [43–49] |
| main-thread turns | 33 [29–37] | 26 [25–30] −21% | 32 [32–37] |
| CLI total_cost_usd | 3.214 [3.033–3.292] | 2.921 [2.807–3.092] −9% (overlap) | 3.246 (+1%) |
| wall time (s) | 141 [128–150] | 184 [162–214] +30% SEPARATED | 151 |

- **Misses:** both misses are the same m3-hook item, so they are noise.
- **Delegation:** every delegation went to Explore (7/7).
- **Re-reads:** none of the 7 reports was followed by a re-read. The parent made
  no Read at all after any of them, against 29.4% of calls on 2026-08-16.
  Compression was 7.1x median (2.9–9.7).
- **Scope:** the questions only ask for answers, so edit-time re-reads went
  unmeasured. In the E2E the parent read just the quoted range before an Edit.
- **Cost:** cite the CLI column. The bench's own cost row priced Explore children
  as Opus (fixed since, see [[delegation-steer-ab-2026-09-23]]).

**What changes for a teammate:**
- **Flipping the default** is the user's call: the cost gain overlaps the noise,
  wall time is +30%. The flip is `isExploreAgentEnabled` plus the expectations in
  `builtInAgents.test.ts` and `exploreAgentGating.test.ts`.
- **Naming Explore in a new prompt** means gating the text on the registry and
  adding the file to `ALLOWED_SITES` in `src/__tests__/exploreAgentGating.test.ts`.
  That test replaced the removal guard.
  `scripts/migrations/probes/exploreAgent.json` proves every guard goes red.
- **Every sub-agent's model changed** with this work, because the model this
  needed never applied: [[subagents-ran-on-parent-model]].

**Rejected:**
- **Read credit for the parent's gate:** format only, user pick. The Bash credit
  cost +6% on top of the batch Read ([[bash-read-passthrough-not-promoted]]). A
  Patch on a never-read file costs one refusal plus `*** Resubmit`.
- **Haiku default:** the user chose Sonnet.

**Evidence:**
- **Run dir:** above.
- **E2E, models:** no `model` → `claude-sonnet-5`, `haiku` →
  `claude-haiku-4-5-20251001`, `inherit` → `claude-opus-5-5`.
- **E2E, report size:** a 22 KB, 451-line report arrived uncut.
- **Excerpt accuracy:** "very thorough" runs went from 20/50 to 41/45 exact
  against the files across three contract revisions (N=1 each). The fixes were
  the excerpt's own range (not its function's), and a full path (not
  `/tmp/.../`).

## Removed (2026-08-18)

The removal was branch `refactor/remove-explore-agent`, `10dc4d18` (#119).
`Plan` stayed. The replacement announced in the prompts *was* a **fork** (`Agent`
with no `subagent_type`). That held until 2026-09-09, when PR #170 (`b7e6913b`)
made a **fresh `Code` agent** the default delegation target and limited the fork
to work that needs the conversation. So the lane that stood in for Explore was
the one that does NOT inherit the parent's context. See
[[fork-vs-fresh-ab-2026-09-09]].

The removal overruled the 2026-08-16 measurement below; it did not refute it.

### What it was measured to be worth (2026-08-16, 99 sessions / 91 Explore calls)

- **93.5% multi-hop.** Of 77 organic calls, 72 needed several dependent searches.
  LOCATE-SYMBOL and READ-ONE-THING were **zero**; only 5 were LOCATE-FILE. Glob
  was 102 of its ~2650 internal tool calls (Read 1188, Grep 807, Bash 547) — it
  was a fan-out reader, never a locator, so "Glob replaced it" was false.
- **13.2x median compression** (82,355 raw chars consumed inside vs 6,483
  returned). Across the 77 organic calls, 6.53M chars (~1.63M tokens) never
  entered the parent's context.
- A fork does NOT reproduce that: it **inherits** the parent's context. What it
  keeps out is the fan-out it performs, not the parent's own prefix. A fresh
  `Code` agent keeps out both, which is what the 2026-09-09 A/B measured at −44%
  total cost for equal answers.

### What actually prompted the removal, and what it was

A session measured on 2026-08-18 (`84a654c9`, legendarr) showed the parent
re-reading **17 of the 35 files** Explore had already read (71,515 B; 12 calls
byte-identical). The cause was **not** the agent: `dispatchArray` in
`src/agent/tools/toolResultSummarizer.ts` ran `maybeCodeOutline()` on the report
before `summarizeAgentOutput()`, so a 26 KB prose report became **683 bytes** of
symbol signatures and the parent immediately Read the 28 KB spill file back.
That is fixed in the same change, and the fix is **tool-scoped**: no Agent result
is ever code-outlined, MCP keeps its arm. See
`src/agent/toolResultCodeOutline.test.ts` → `agent reports are never outlined`.

### Still reproducible

`bun scripts/bench/tokens/measure-explore-redundancy.ts [projectDir]` parses
transcripts, so the 2026-08-16 baselines stay measurable from disk:

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
targeted, vs Explore's 22.7%). See also [[dev-tooling-token-roadmap]] and
[[outline-blind-to-nested-members]].
