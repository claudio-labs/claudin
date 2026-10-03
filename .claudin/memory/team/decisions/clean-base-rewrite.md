---
name: clean-base-rewrite
description: 2026-09-27 — every inherited module (Claude Code base + openclaude) is rewritten from spec on branch `rewrite` (was rewrite/clean-base), never refactored; provenance:ci ratchet blocks new inherited lines; LICENSE stays MIT meanwhile
type: project
scope: repository
impact: structural
---

**Decision:** on 2026-09-27 the user chose to make Claudin entirely this project's own code, so that the MIT `LICENSE` covers the whole tree.
- Every module that matches the Claude Code base or the openclaude fork point is **rewritten from a spec and the tests**, never refactored.
- The work lives on branch `rewrite`, pushed to origin. Until 2026-10-03 it was `rewrite/clean-base`, plus `rewrite/levers`. Work is merged into it with no pull request. Both `main` and the branch take features, and the branch merges `main` at least weekly.
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
- **Levers round, 2026-10-02/03.** Plan and outcome are in `docs/tech/rewrite/levers.md`. Every defect the round pinned is in `levers-findings.md`.
  - **Only dead code is cut.** The user asked "a gente não vai remover nenhuma funcionalidade?". Since then, no feature a user can reach today leaves the product, even one that needs a claude.ai login or an Anthropic server. That keeps the bridge, teleport, `/remote-env`, `/install-github-app`, `/stickers`, `/desktop`, policy limits, the marketplace, the swarm, PowerShellTool and `/buddy`. The cut was BriefTool, direct-connect, the remote agent task, speculation and the installer's download path: about 4.9k inherited lines.
  - **Replaced by opencode code** (MIT, notice in `THIRD_PARTY_NOTICES.md`): the LSP client, the MCP OAuth provider and flow, and Codex OAuth.
  - **Rejected:**
    - The Bash arity-table port widened the "always allow" default from `rm build:*` to `rm:*`.
    - The npm `yoga-layout` swap was 2–3x slower; the port is rewritten in phase 9 with the package as a test oracle.
    - A Vercel AI SDK spike for the providers.
  - **Cover before touching:** every surviving file a lever or rewrite edits first reaches its `testing.md` target, 70% where none is set (`bun run rewrite:coverage`).
- **Per-method rewrite measured 2026-10-03** on `vcs/worktree`: 1,104 inherited lines down to 41 of residue, in about 0.24 M tokens per thousand lines for the implementation, or about 0.5 M with characterization. The ~335 k lines left come to about 170 M tokens, not 600 M. Process: a `bodies` sandbox stubs the inherited bodies, and the unit's characterization suites are the spec.
