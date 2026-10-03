# The clean-base rewrite

The goal is a tree in which every line was written by this project, so that the
MIT `LICENSE` covers all of it. Today it does not. Claudin was cut from
openclaude (`9e23c2be` plus #882 and #908), and openclaude's base is the Claude
Code source: proprietary, and, in openclaude's own `LICENSE`, code it "does not
have Anthropic's authorization to distribute".

Measured on 2026-09-27 by distinctive line, production code was **55.7% Claude
Code and 3.8% openclaude**, and the tests were **87.7% this project's own**. The
live numbers, module by module, are in [inventory.md](inventory.md).

The work happens on the `rewrite` branch. Since 2026-10-03 it holds what used to
be `rewrite/clean-base` and `rewrite/levers`. Each piece of work is written, then
merged into `rewrite` and pushed, with no pull request, until the code is
entirely this project's own. A working branch can't be named `rewrite/...`
any more, because git refuses a branch nested under another branch's name. Use
`rewrite-phase-<n>`, or land straight on `rewrite`. Both `main` and the branch
take new features; the branch merges `main` at least weekly (see
[Merging main](#merging-main-into-the-branch)).

## Why rewrite and not refactor

Renaming variables, retyping, reformatting and moving files leaves code derived
from what it was derived from. It also fools any line-based measure, which is
why the measure below normalizes identifiers. Inherited code leaves the tree in
one way only: the module is deleted, and a new implementation is written from a
specification and from the tests, never from the old source.

Since 2026-10-02 two cheaper exits come first, and the rewrite itself can go
one function at a time instead of one module at a time: cut the feature,
replace it with MIT code under its own notice, or rewrite each inherited body
without seeing it. [levers.md](levers.md) has the cuts, the replacements, the
per-method sandbox and the rule to cover a file with tests before touching it.

## The measure

`scripts/verify/provenance/` compares every tracked file against 32-bit hashes
of the two origins. Only hashes are committed (`fingerprints.bin`), never text.

| | |
|---|---|
| **Lines** | a distinctive line (trimmed, whitespace collapsed, ≥25 characters, has a letter), hashed verbatim. The only measure that sees copied comments and prose. |
| **Tokens** | the code as a token stream with identifiers, strings, numbers and regexes collapsed to their kind, cut into 40-token grams and winnowed (the MOSS algorithm). Renaming or reformatting leaves it unchanged. |
| **Runs** | a hit counts only next to another one, which keeps chance matches of 32-bit hashes near one in a hundred million. |

| Command | What it does |
|---|---|
| `bun run provenance` | totals and one row per slice |
| `bun run provenance --files 40` | the files with the most inherited lines |
| `bun run provenance --file <path>` | the matching line ranges of one file, by origin |
| `bun run provenance --inventory` | regenerates [inventory.md](inventory.md) |
| `bun run provenance:ci` | the ratchet (below) |
| `bun run provenance:fingerprints` | rebuilds `fingerprints.bin` from a local openclaude clone (`PROVENANCE_REF_REPO`, default `../openclaude`) |

**Calibration (2026-09-27).**
- **Chance matches.** On opencode, 678k lines of unrelated TypeScript, the measure flags **0.08%** of lines.
- **Inherited files.** It covers **80%** of inherited Claude Code files.
- **Renamed copies.** For copies of the Claude Code base with every identifier renamed, the tokens find about 84% of what they find in the unrenamed copies. The line measure alone finds **0%** of them.
- **Why grams must be varied.** Without the rule that a gram needs 10 distinct token kinds, opencode's i18n tables alone produced 16.8% chance coverage.

**What it cannot see:**
- A copy shorter than about 57 tokens (a handful of lines).
- Structure copied without its code: a module laid out like the old one, the same functions in the same order. The spec rules below exist for that.
- Who wrote third-party text that openclaude also carried. `CODE_OF_CONDUCT.md` is the Contributor Covenant and shows up as openclaude.
- Anything that is not a code, `.md` or `.txt` file. In particular, the probe specs (`scripts/migrations/probes/*.json`) quote the lines they mutate, and snapshots (`*.snap`) can hold inherited text. The final cut reviews both by hand.

Import and re-export lines are left out of both measures. They are wiring:
two unrelated files that import `join` from `'path'` share nothing worth
counting.

The numbers are evidence for the process. They are not a legal opinion.

## The gate

`bun run provenance:ci` runs in `pr-checks.yml`, on every PR and on pushes to
`main` and `rewrite`. It holds each file to the inherited lines
recorded in `provenance-baseline.json`, and a file the baseline never saw is
allowed none.

When a module's inherited count goes down, run `bun run provenance:baseline` in
the same commit. The refresh refuses to raise the total. Moving a file keeps the
total, so it goes through, but it has to be refreshed in the same change. The
`--allow-growth` flag exists for one case only: rebuilding the reference after
`fingerprint.ts` changed its `PARAMS`.

## Definition of done, per module

1. **Regression tests first, against the old code.**
   - Characterization tests go on the module's public contract (black box), so they survive the rewrite.
   - Coverage of the old module must reach the targets in `.claudin/rules/testing.md` (providers 80%, shared 75%, everything else 70%), measured with `bun run test:coverage`.
   - Every new test must be proved by `scripts/migrations/break-probe.ts`, with its spec committed as `scripts/migrations/probes/rewrite-<module>.json`. A probe that turns nothing red is a finding, not a pass.
2. **The spec,** at `docs/tech/rewrite/<slice>/<module>.md` ([template](spec-template.md)). It records observable behaviour, the public contract and the edge cases. It carries no code, no internal names and no internal structure of the old module.
3. **The removal.** The module's inherited files are deleted in the sandbox, not in a commit of their own. The deletion and the new implementation land together, so the branch never has a commit that does not build.
4. **The implementation,** in the sandbox below, by a fresh agent (or person) who has the spec, the tests and the project's own code, and nothing else. It follows `.claudin/rules/code-design.md` and `.claudin/rules/typescript-patterns.md`.
5. **The gate.**
   - `bun run provenance --file <path>` shows zero inherited lines for every new file, apart from reviewed **residue**: lines the public contract dictates, such as exported signatures and type fields kept for callers not yet rewritten, or protocol field names. The spec's Outcome section lists the residue and why each part is there. Anything else is rewritten.
   - `bun run provenance:baseline` lowers the baseline.
   - The probe spec is rewritten against the new code, and every probe still turns the suite red. The old spec quoted the old code, so it goes.
6. **The checks.**
   - `bun run build`, `bun run typecheck`, `bun test`, `bun run smoke` and `bun run verify:privacy` all pass.
   - A module with UI is also driven in the real app (`/verify`).
7. **Cleanup.** Comments that describe upstream history ("upstream", "Claude Code", "openclaude") go with the module. References to another product as a product stay, for example the `/import` adapter that reads a user's `~/.claude`. Then regenerate the inventory.

### Contracts during the transition

A rewritten module keeps the exported names and types that the modules not yet
rewritten still call. Its internals are free, and they follow the new
standards from day one. The public contract is redesigned once every consumer
has been rewritten.

### The implementer's sandbox

The old source must be out of reach, not just out of the brief. The tools in
`scripts/migrations/rewrite/` do the mechanical part; a unit is a named group
of files in `units/phase-<n>.json`.

```sh
export REWRITE_SANDBOX_ROOT=<a scratch directory>
bun run scripts/migrations/rewrite/sandbox.ts char <unit>   # characterization: HEAD as it is
bun run scripts/migrations/rewrite/sandbox.ts impl <unit>   # implementation: the old code taken out
bun run scripts/migrations/rewrite/sandbox.ts bodies <unit> # per method: only the inherited bodies taken out
bun run scripts/migrations/rewrite/land.ts <sandbox>        # what the agent changed; --apply brings it back
```

Each sandbox is a copy of HEAD with no `.git`, so no history to read, next to
a pristine copy (`<sandbox>.base`) that `land.ts` diffs against. A file the
checkout changed since that copy is a conflict, and nothing lands while there
is one. So several units can run at once, each in its own sandbox, and only
the finished work reaches the checkout.

An `impl` sandbox has none of these:
- the unit's files and inherited tests;
- its probe spec, and any older probe spec that probes those files (both quote the old code);
- the fingerprints, because the gate checks the result and is not the implementer's tool;
- the team memory;
- any doc, bench or snapshot that names one of the old code's private declarations, or quotes one of its lines of 40 characters or more. Benches quote old code too: `scripts/bench/ab/delegation-steer-ab.ts` held lines of the old skill loader, and the system-prompt snapshots hold the old prompts. A snapshot taken out is written afresh by the implementer's run, and `land.ts` lists it for review.

A private name or a quoted line found anywhere else is reported, not removed.
Review each one before the brief: inside `src/` it is usually an unrelated
function with the same name, or a line another inherited module shares, but in
a rule or a spec it is a leak. Reword whatever quoted the old
code against the new module in the rewrite's commit. When the implementation
lands, `land.ts` lists the stale probes in the older specs it took out, and every
added or changed file of the unit that still matches inherited code. Review
that list rather than the CI gate: a file rewritten at its old path keeps its
old count in the baseline, so the gate passes it whatever it holds. Re-point
each at the line of the new code that carries the same behaviour and prove it
with break-probe; prune one (`stale-probes.ts --prune`) only when the spec
dropped the behaviour. A pruned probe leaves this project's own test unproven
against the rewrite.

The implementer works in the sandbox. The brief:
- names the spec, the test files and the rules;
- forbids reading the main checkout and the openclaude clone, running git, and looking the old implementation up anywhere;
- asks for explicit confirmation of all that in the report.

When the checks pass there, land it and run the gate. The gate is what
verifies the isolation: a copy, renamed or not, shows up there.

**Pilot notes** (`skills/bundledSkills`, 2026-09-27):
- **Cost.** One fresh agent took about 11 minutes and 49 tool calls to write two files (267 lines) that passed the 20-test suite and `tsc` on the first report.
- **A finding the old code shared.** The agent raised a security gap that the old module had too, and the spec now records it.
- **Residue comes from the spec.** A contract table that lists a type's fields in the old order leads to a type with the same field order. That is fine, since it is contract, but it is why residue exists.

**Pilot notes** (`skills/loadSkillsDir`, 2026-09-28):
- **Characterization.** An agent that reads the old code took about 40 minutes for 103 tests, 40 probes and the spec. The implementer took about 32 minutes for 1,100 lines across 11 files.
- **Probes against the new code.** A third agent re-authored them in about 11 minutes: 59 probes, all red.
- **Findings from characterizing.** It surfaced a security finding (skill arguments reach the shell pass) and six unpinned oddities. The spec decides each one: fix, keep for parity, or track.
- **Keep the sandbox free of fingerprints.** The implementer ran the census and reshaped contract declarations until it read zero. Harmless this time, but the gate has to stay independent.
- **Characterization and the break-probe run must not overlap.** A probe run mutates a source that other suites import. Run the probes one spec at a time, with nothing else testing.

**Pilot notes** (`skills/ui/SkillsMenu`, 2026-09-28):
- **Test harnesses leak too.** The characterization suite first copied its Ink-mounting harness from an inherited test, and 37 of its lines matched openclaude. `src/terminal/__testutils__/fakeTerminal.ts` is this project's harness: a TTY-looking stdin and a stdout that records frames. Use it, and let the inherited tests that still carry the old harness move over when they are rewritten.
- **Run the gate on the new tests as well as the new code.** A new test file is held to zero like any other new file.

**Pilot notes** (`skills/bundled` prompt skills, 2026-09-28):
- **Prose is rewritten from intent.** The spec lists, for each prompt, what it must get the model to do and the facts it must state, with no sentence of the old text. The suite pins those facts with targeted matches, never whole sentences.
- **The harness itself can leak.** A sub-agent's skill listing shows the installed skills' descriptions, which are the old ones until the rewrite ships. Tell the implementer, and let the gate verify.
- **A fix is not done until a test pins it.** The probe run showed that nothing noticed the CLI name reverting; a small test now does.

**Phase 2 notes** (ten units at once, 2026-09-28):
- **Ten sandboxes run side by side.** Ten characterizations, then ten implementations, each in its own copy, took about an hour per round. The main checkout only received finished work, through `land.ts`.
- **Agents share one shell.** A sub-agent that changes directory leaves the next command there, and a relative `land.ts` run from inside a sandbox takes that sandbox for the checkout. Run the rewrite scripts by absolute path.
- **The ratchet is not the review.** Files rewritten at their old paths kept their old counts in the baseline, so `provenance:ci` passed 15 of them that still matched 75 lines. `land.ts` now lists every file of the unit that matches; each is reworded or recorded as residue.
- **Matches in new tests are mostly shape.** A run of `expect(f(x)).toBe(y)` or of `useState` lines matches the reference with every name and literal different. Tables of plain strings, looped over, do not; 69 such lines went to zero without losing a case.
- **A prompt rule the suite does not pin can vanish.** The memory prompt's short decisions line lost "nothing for a teammate, not a decision", because the facts were pinned on the long form only. Pin the facts of every rendered form of a prompt line.
- **Re-point displaced probes, do not prune them.** 15 probes of this project's own specs quoted the old memory code. Each was re-pointed at the line that carries the same behaviour now, and each still turned its suite red.
- **Run the whole suite before committing a characterization suite.** The lifecycle suite passed alone and next to its neighbours, but three older suites left module mocks in place for the rest of the run. Its first full run came only with the implementations: 23 failures, all from those leaks, fixed at the source.

### Porting this project's own code

Only a whole unit (a file, or a function) moves across verbatim, and only when
`bun run provenance --file` shows zero inherited lines in it. Anything
interleaved with inherited lines goes through the spec like the rest.

## Merging main into the branch

- **A module not yet rewritten:** merge normally.
- **A module already rewritten:** git reports a modify/delete conflict. Keep the deletion, take the test that came with the change, and implement the behaviour in the new module.
- **New features on `main`:** they should come with behaviour tests, not tests of internals, so that they travel to the branch unchanged.

## Order

Leaves first, the core last, so that each phase builds on modules that are
already rewritten. `scripts/verify/provenance/phases.ts` holds the mapping, and
[inventory.md](inventory.md) shows the numbers per phase.

| Phase | Scope |
|---|---|
| 1 | Pilot: `src/skills`. Calibrates the process and its cost before anything larger. |
| 2 | `src/memory`, `src/vcs`, `src/sessions` |
| 3 | `src/mcp`, `src/permissions` |
| 4 | `src/shared` |
| 5 | `src/providers`, including the openclaude-authored shims |
| 6 | `src/tools`, and the shell parsers in `src/platform/shell` and `src/platform/bash` |
| 7 | `src/commands`, `src/plugins` |
| 8 | `src/platform` |
| 9 | `src/terminal`, `src/native-ts`: the renderer's direction (own, or an MIT library) is decided in this phase's spec |
| 10 | `src/agent` |
| 11 | `scripts/` |
| 12 | The final cut |

Every phase gets its own plan when it starts, drawn module by module from the
inventory: [phase 2](phase-2.md) (done 2026-10-03), [phase 3](phase-3.md).

### What the pilot measured (phase 1, finished 2026-09-28)

**Result.** `src/skills` went from 2,264 inherited lines to 144. What remains
is reviewed residue: contract-dictated declarations and generic idioms.
Data-driven tests (`expect(text).toContain(…)` in a row) also match other
test suites by shape, and the census counts them. Five module groups went
through the whole process. Characterizing them found:
- two security findings, recorded in the team bug memory;
- about a dozen defects, which the rewrites fixed where no compatibility was at stake.

**Cost.** Twelve sub-agent runs spent about 3.5 M tokens and 5.7 agent-hours
on those 2,120 lines, some of them in parallel. That works out to roughly
1.7 M tokens and 2.7 agent-hours per thousand inherited lines. The orchestrator's
own reviews, gates and commits come on top.

**What it means for the rest.** At the pilot's rate, the ~353 k lines left
would cost on the order of 600 M tokens and 950 agent-hours. Three levers
change that more than tuning the process would:
- **Cut** what the product does not need: every cut line costs nothing to rewrite, as `/insights` showed.
- **Replace** an inherited subsystem with a maintained MIT library where one fits. The renderer in phase 9 and the yoga port are the obvious candidates.
- **Run several modules at once,** each in its own sandbox. Only break-probe runs have to be serialized.

## The final cut

- **The gate reads zero across the tree.** Whatever residue remains is chance matches, or third-party text under its own license. It is reviewed file by file and acknowledged explicitly, never dropped from the measure.
- **History.** The clean base is published with fresh history, because the old history carries the inherited code. How it is published (a new repository or an orphan root) is an outward-facing, irreversible step, and it needs explicit confirmation when it comes.
- **Legal review.** A lawyer's opinion is recommended before announcing the codebase as entirely this project's own.
