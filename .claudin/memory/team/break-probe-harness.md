---
name: break-probe-harness
description: scripts/migrations/break-probe.ts runs agent-safety.md's break-and-restore method as a batch over a committed JSON spec; 18 specs live under scripts/migrations/probes/ and are re-runnable after any later refactor
type: reference
---

`.claudin/rules/agent-safety.md` §4 requires break-and-restore for every new
test but never names the tool that does it. It exists:

```
bun run scripts/migrations/break-probe.ts scripts/migrations/probes/<spec>.json
```

For each probe it mutates ONE exact string in a production file, runs the named
suites, records which tests went red, and restores. **A probe that turns nothing
red is the finding** — the line it mutated is not guarded, and the test claiming
to cover it passes for some other reason.

Spec shape (`test` may be a list; `source` may be overridden per probe):

```json
{ "test": ["path/a.test.ts"], "source": "src/x.ts",
  "probes": [{ "name": "...", "comment": "...", "find": "...", "replace": "..." }] }
```

18 specs are committed under `scripts/migrations/probes/`. They are the evidence
for the suites they name and stay re-runnable after later refactors, so add one
rather than doing a throwaway manual pass.

**Two safeguards it gives you for free**, both of which have produced green
tests that guarded nothing in this repo: `find` must match **exactly once** or
the probe is refused (no silently mutating a same-looking line elsewhere), and
the original text is held in memory and written back in a `finally`, with a
byte-identical re-verification at the end (no dirty tree on a crash).

**It catches the fail-open trap that hand review misses.** On #227 the
`companion_intro` probe reported *"NOTHING WENT RED"*: without an adopted
companion `getCompanion()` returns undefined, so the producer returned `[]` with
the gate deleted too — the test certified nothing. Fix: **seed the precondition**
(`saveGlobalConfig` an actual companion) so an empty result can only come from
the gate, and **add a control arm** asserting the main thread still gets it. See
[[attachment-producers-leak-parent-state]].

Related: [[characterization-net-before-deletion]],
[[feedback-pin-the-surviving-surface]] (private),
[[tier3-file-split-roadmap]] §5 — a break-probe pass also surfaces
genuinely **unreachable** lines, which are a documentation job, not a test defect.
