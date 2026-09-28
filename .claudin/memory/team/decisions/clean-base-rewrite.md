---
name: clean-base-rewrite
description: 2026-09-27 — every inherited module (Claude Code base + openclaude) is rewritten from spec on branch rewrite/clean-base, never refactored; provenance:ci ratchet blocks new inherited lines; LICENSE stays MIT meanwhile
type: project
scope: repository
impact: structural
---

**Decision:** on 2026-09-27 the user chose to make Claudin entirely this project's own code, so that the MIT `LICENSE` covers the whole tree.
- Every module that matches the Claude Code base or the openclaude fork point is **rewritten from a spec and the tests**, never refactored.
- The work lives on branch `rewrite/clean-base`. Both `main` and the branch take features, and the branch merges `main` at least weekly.
- The only feature cut instead of rewritten is `/insights`. The openclaude-authored code (mostly provider shims) is rewritten too.
- The `LICENSE` stays plain MIT during the migration. That is the user's call, taken knowing it overclaims until the cut.

**Why:** renaming, retyping or moving inherited code leaves it derived, and fools a line-based measure. openclaude's own `LICENSE` says its base is proprietary Claude Code source it has no authorization to distribute.

**What changes for a teammate:**
- `bun run provenance:ci` (in `pr-checks.yml`) fails any file that matches more inherited code than `provenance-baseline.json` allows.
- Matches are counted verbatim, and also with identifiers renamed (winnowed token grams). So porting from `../openclaude`, pasting old code into a new module, or a rename-only "cleanup" all turn it red.
- After a rewrite, or after moving a file, run `bun run provenance:baseline` in the same commit. The refresh only ever lowers the total.
- The process (definition of done, the sandbox without `.git`, the merge policy for `main`) is in `docs/tech/rewrite/README.md`, and the per-phase numbers are in `docs/tech/rewrite/inventory.md`.
- The history cut at the end needs explicit confirmation.

**Rejected:**
- Refactoring the inherited code in place and relicensing it: still derived.
- Restoring the NOTICE preamble in `LICENSE`, or a separate NOTICE file: the user declined both on 2026-09-27.
- A new repository from scratch: months without a usable release.

**Evidence:**
- Measured 2026-09-27 by distinctive line: production code is 55.7% Claude Code and 3.8% openclaude; tests are 87.7% own. With tokens, 361,433 inherited lines of 914k.
- Calibration against opencode: 0.08% chance coverage. A renamed 80-line Claude Code block went red on 46 lines when probed.
- **Pilot done 2026-09-28.** `src/skills` went from 2,264 inherited lines to 144 of reviewed residue.
  - **Cost:** about 3.5 M sub-agent tokens and 5.7 agent-hours, roughly 1.7 M tokens per thousand lines. Extrapolated, the remaining ~353 k lines come to about 600 M tokens.
  - **Levers before scaling:** cut, replace with an MIT library, or parallelize. See `docs/tech/rewrite/README.md`, "What the pilot measured".
- **Phase 2, first ten units, 2026-09-28.** Characterized and implemented in parallel sandboxes. Phase 2 went from 17,253 inherited lines to 10,405, the tree to 346,750. Twelve units of phase 2 remain (`docs/tech/rewrite/phase-2.md`). The CI ratchet does not review a file rewritten at its old path; `land.ts` lists what still matches.
