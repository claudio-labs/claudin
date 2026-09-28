# The clean-base rewrite

The goal is a tree in which every line was written by this project, so that the
MIT `LICENSE` covers all of it. Today it does not. Claudin was cut from
openclaude (`9e23c2be` plus #882 and #908), and openclaude's base is the Claude
Code source: proprietary, and, in openclaude's own `LICENSE`, code it "does not
have Anthropic's authorization to distribute".

Measured on 2026-09-27 by distinctive line, production code was **55.7% Claude
Code and 3.8% openclaude**, and the tests were **87.7% this project's own**. The
live numbers, module by module, are in [inventory.md](inventory.md).

The work happens on the `rewrite/clean-base` branch. Both `main` and the branch
take new features; the branch merges `main` at least weekly (see
[Merging main](#merging-main-into-the-branch)).

## Why rewrite and not refactor

Renaming variables, retyping, reformatting and moving files leaves code derived
from what it was derived from. It also fools any line-based measure, which is
why the measure below normalizes identifiers. Inherited code leaves the tree in
one way only: the module is deleted, and a new implementation is written from a
specification and from the tests, never from the old source.

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

The numbers are evidence for the process. They are not a legal opinion.

## The gate

`bun run provenance:ci` runs in `pr-checks.yml`, on every PR and on pushes to
`main` and `rewrite/clean-base`. It holds each file to the inherited lines
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
3. **The removal commit.** It deletes the module's inherited files.
4. **The implementation,** in the sandbox below, by a fresh agent (or person) who has the spec, the tests and the project's own code, and nothing else. It follows `.claudin/rules/code-design.md` and `.claudin/rules/typescript-patterns.md`.
5. **The gate.**
   - `bun run provenance --file <path>` shows zero inherited lines for every new file.
   - `bun run provenance:baseline` lowers the baseline.
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

The old source must be out of reach, not just out of the brief. After the
removal commit:

```sh
SANDBOX=$(mktemp -d)
git archive HEAD | tar -x -C "$SANDBOX"           # no .git, so no history to read
ln -s "$PWD/node_modules" "$SANDBOX/node_modules"
```

The implementer works in `$SANDBOX`, with a permission rule denying reads of
the openclaude clone. The brief names the spec, the test files and the rules,
and forbids looking the old implementation up anywhere. When the checks pass
there, copy the module's directory back and run the gate.

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
inventory.

## The final cut

- **The gate reads zero across the tree.** Whatever residue remains is chance matches, or third-party text under its own license. It is reviewed file by file and acknowledged explicitly, never dropped from the measure.
- **History.** The clean base is published with fresh history, because the old history carries the inherited code. How it is published (a new repository or an orphan root) is an outward-facing, irreversible step, and it needs explicit confirmation when it comes.
- **Legal review.** A lawyer's opinion is recommended before announcing the codebase as entirely this project's own.
