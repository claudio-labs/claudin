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
rules (src/utils/permissions/permissionSetup.ts:866-876), which is what actually
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

**Why:** every number this bench produced before the last fix was wrong, and not
conservatively so — 2.01× and 2.35× both looked defensible and both died to a
direct check. The errors did not push in a consistent direction, so "it is
roughly this" was never available; only the separated metrics were.

**How to apply:** when writing or reading any headless token/cost bench in this
repo, check these five before trusting a delta; treat a run where any arm used a
tool outside its gate as discarded. See [[auto-outline-pivot-false-cap-claim]]
for the bench these came from and [[clip-pin-cache-ab-2026-07-25]] for the
earlier, fixture-shaped set of bench traps.
