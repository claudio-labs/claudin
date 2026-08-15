---
name: token-bench-measurement-traps
description: Traps that make a headless A/B token bench measure the wrong thing — the --allowedTools non-gate, per-content-block usage rows, arm-ordering cache warmth and its odd-N imbalance, metrics structurally zero in one arm, dropping cache-read from cost, a rounding median, and process checks that match themselves
type: project
---

Learned 2026-08-09 building `scripts/profile/read-outline-pivot-ab.ts`. Each of
these produced a confidently wrong number that survived a first review and only
fell to a direct check, so verify them explicitly in any new bench.

**`--allowedTools` does not remove tools — use `--tools X --strict-mcp-config`.**
It only ever produces *allow* rules, and registry filtering happens exclusively
through *deny* rules (`getTools` → `filterToolsByDenyRules`, src/tools.ts:383).
Measured on one prompt: **40 tools visible** under `--allowedTools Read,Glob`,
with Grep, Bash and Agent present and callable, versus **exactly 2** under
`--tools Read,Glob --strict-mcp-config`. `--tools` inverts the list into deny
rules (src/permissions/permissionSetup.ts:866-876), which is what actually
deletes them; `--strict-mcp-config` is needed alongside because `--tools` leaves
MCP tools untouched. The first run of the pivot bench had arm A reach for Grep
twice while arm B never did — that arm never exercised the tool under test.
Always report the per-arm tool mix so an escape is visible, not silent.

**Usage rows are per content block, not per message.** The transcript writes one
line per block, all sharing `message.id`: `input` and `cache_*` repeat
identically, but `output_tokens` **grows** as the message streams. Summing every
line multiplies the input and cache terms; keeping the first sighting undercut
output by **104× in one arm and 17.8× in the other** on the same run. Neither
error is uniform across arms, so neither preserves even the ratio. Take the max
per `message.id`.

**Whichever arm runs first pays the cold prompt cache.** The second inherits the
warm prefix even from a different cwd — worth ~19% of the measured gap here.
Alternate the arm order across reps.

**A metric can be structurally zero in one arm and look like a finding.**
"Follow-up reads of an outlined path" is necessarily 0 in the pivot-off arm
because no path is ever outlined there, so a reported "35 vs 0" compared nothing.
Define comparison metrics so both arms can produce a non-zero value.

**Cache read is usually the dominant term — do not proxy cost with a token sum
that drops it.** `input + output + cacheWrite` excluded the largest line item and
inverted the conclusion. Price all four terms.

**A median over N=3 can still be a non-finding — check whether the ranges
overlap.** The pivot bench's cost went 2.01× → 2.35× → **1.30× median at N=3**,
and at that point the cheapest pivot-ON run was cheaper than the priciest
pivot-OFF one. Overlapping ranges mean no cost claim, however clean the median
looks. In the same run three other metrics (turns, end context, wall time)
separated with no overlap at all — so report per-metric separation, never one
headline multiple.

**Counting that an outline appeared does not prove WHICH text was served.** The
wording arm's guard checked `pivots > 0` and tool escapes, which both pass when
a stale `dist/` puts the *identical* footer in both arms — the run then reads as
a clean null and nothing in the numbers gives it away. This nearly went
unnoticed once: a `grep -c` for the new header returned 0 on every chunk and
looked like proof the dev bundle was stale, when it was ripgrep omitting an
over-long minified line; a direct `Read` of that line showed the fix present.
Assert the served text per arm (`servedFullHint`, added 2026-08-09) and abort on
rep 1, before paying for the reps. Corollary for the tooling: on a minified
bundle prefer a ranged `Read` over `grep -c`, whose long-line omission is silent.

**In a cross-CLI bench, the stream can under-report ONE arm's output.** Measured
2026-08-12 building `scripts/profile/cli-search-edit-ab.ts` (claudindev vs
claude, same task): summing max-per-`message.id` over `--output-format
stream-json` gave claude **242** output tokens against its own transcript's
**4,333** — 17.9x — while `input`, `cache_read` and `cache_creation` matched to
the token, and claudin's stream and transcript agreed exactly on the same run.
claude's stream flushes an early usage snapshot; the final one only reaches
`~/.claude/projects/<slug>/<sid>.jsonl`. So the usual "fall back to the
transcript when the stream is empty" guard fires for neither arm and the
undercount survives. MERGE the two sources by message id, max per field, and
print which arm needed the merge. A cross-CLI bench must never assume the two
CLIs flush usage at the same point.

**A null is only publishable if the arms were verifiably different.** Both the
2026-08-08 and 2026-08-09 wording runs produced nulls; only the second is worth
citing, because only it proved the arms served different text. Before recording
"no effect", show the manipulation landed.

**Why:** every number this bench produced before the last fix was wrong, and not
conservatively so — 2.01× and 2.35× both looked defensible and both died to a
direct check. The errors did not push in a consistent direction, so "it is
roughly this" was never available; only the separated metrics were.

**How to apply:** when writing or reading any headless token/cost bench in this
repo, check these five before trusting a delta; treat a run where any arm used a
tool outside its gate as discarded. See [[auto-outline-pivot-false-cap-claim]]
for the bench these came from and [[clip-pin-cache-ab-2026-07-25]] for the
earlier, fixture-shaped set of bench traps.
