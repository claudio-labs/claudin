---
name: pre-pr
description: Run Claudin's pre-PR validation gate (build, smoke, typecheck, test floor, unused-dependency check, rule health, PR-title format, focused tests, and — when the diff warrants — test:provider and verify:privacy) and report a pass/fail summary. Use before opening or updating a PR.
allowed-tools: Bash, Typecheck, RunTests
argument-hint: "[path/to/changed.test.ts ...]"
arguments: testPaths
---

# /pre-pr — pre-PR validation gate

Run the checks Claudin expects before a PR and report a concise pass/fail
summary. The full rationale lives in `.claudin/rules/testing.md` (Pre-PR
Checklist) and `.claudin/rules/build-system.md`.

## Steps

Two responses, then the report — every model response is a request, and the
checks after the build don't depend on each other:

- **First response:** step 1 alone. Stop and report if it fails; nothing after
  it means anything on a broken build.
- **Second response:** steps 2–7 together, as parallel calls in ONE response.
  They read the tree and the bundle and change neither, so no order is needed.
  Report every result, failures included, instead of stopping at the first.
- Step 8 needs no call.

1. **Build + smoke** — `bun run smoke`. It runs `bun run build` first and then
   the `--version` sanity check, so it is the build step as well; running
   `bun run build` before it would build twice.
2. **Typecheck** — call the **Typecheck** tool with no arguments. It runs the
   project's checker and reports only the diagnostics missing from the recorded
   baseline, so the pass condition is simply **zero new**. Do not count absolute
   errors and do not compare against a remembered number: this repo carries
   thousands of pre-existing `tsc` errors and that total drifts.
   - `⚠ … provenance unknown` means no baseline exists for the current commit
     and none could be reconstructed — uncommon, since a dirty tree with no
     baseline re-checks HEAD in a temporary worktree. That is not a failure by
     itself: read the listed diagnostics and judge whether any belong to this
     change.
3. **Focused tests** — call the **RunTests** tool for the changed code. If
   `$ARGUMENTS` names test files, pass them as `path`. Otherwise infer the
   colocated `*.test.ts` next to the files in `git diff --name-only` and run
   those.
4. **Test floor** — `bun run test:floor`. A ratchet, not a target: it fails if
   the test-to-source LOC ratio drops more than 0.5pp below the recorded floor,
   or if one of the seven named invariant suites has disappeared. A refactor
   that deletes a suite along with the code it covered is what this catches.
   Raising the floor is deliberate — `bun run test:floor:update`, in the same
   commit that earned it.
5. **Dead code** — `bun run deadcode:ci`, and `bun run deadcode:exports` beside
   it (the unused-export ratchet from the Pre-PR checklist in `testing.md`: it
   fails only on findings the branch adds). deadcode:ci covers unused files and
   declared dependencies that nothing imports; both were cleared to zero on 2026-08-07,
   so any finding belongs to the branch. A file finding is a question, not a
   verdict — one of the nineteen deleted turned out to be a migration nobody
   had wired up. The wider `bun run deadcode` also lists used-but-undeclared
   imports, which do NOT gate: this fork resolves ~30 module names to stubs in
   `scripts/build/build.ts` that knip cannot see, so "undeclared" is the intended
   state there rather than a defect.
6. **Generated SDK types** — `bun run verify:sdk-types`. Gates in CI, so a green
   local run without it ships a red PR. It fails when
   `src/platform/entrypoints/sdk/coreTypes.generated.ts` no longer matches what
   `coreSchemas.ts` would produce.
   - **Do not just regenerate and commit.** Regeneration always makes the check
     pass, including when the reason it broke is that a schema went missing —
     the shrunk output is then a silent break of the SDK's public API. Read the
     diff first: removed `export type` lines mean restore the schema, not accept
     the loss.
   - The inputs are invisible to `deadcode:ci`, which is how they get deleted in
     the first place. Nothing in this repo imports `OutputFormatSchema` or
     `HookJSONOutputSchema`; the generator is their only consumer.
7. **Rule health** — `bun run verify:rules`. Gates in CI. It fails on the two
   rule defects that are invisible at runtime: a `paths:` matching no tracked
   file (the rule never loads) and an unsupported frontmatter key such as
   `globs:` (the rule loads into *every* session instead of the files it was
   scoped to). Stale path references in prose are reported as warnings and do
   not gate.
   - It also gates the always-loaded cost — AGENTS.md plus every rule with no
     `paths:` — at 20,000 characters per turn, and prints the running total.
     When that ceiling fails, the fix is to scope the newest prose with
     `paths:`, not to raise the number; a jump with no new rule means an
     existing rule lost its `paths:`.
8. **PR title** — check the title you are about to use against
   `.claudin/rules/git-conventions.md`: `type(scope): summary`, with `type` one
   of the ones `scripts/release/release-notes.ts` maps. This gates nothing in
   CI, which is the point — a title that misses it is silently published under
   **🔧 Miscellaneous** in the release notes, and correcting it after the merge
   means rewriting published history.

## Conditional steps (only when the diff touches these areas)

- **Provider / context** (`src/providers/**`, `src/agent/context*`):
  `bun run test:provider`. Both trigger paths named directories the reorg
  retired, so this step had stopped firing on exactly the diffs it exists for.
- **Build / telemetry / network** (`scripts/build/build.ts`, the bundle plugins,
  anything network-adjacent): `bun run verify:privacy`.
- **Output-format changes**: re-run the affected snapshot tests and confirm the
  `.snap` diffs are intended (`bun test --update-snapshots <file>` only after
  reviewing).

## Reporting

End with a compact table: each check → ✅/❌ and, for any failure, the first
actionable line of output. Do NOT open the PR from this skill — it only
validates. If everything passes, say so plainly and name which conditional
checks were skipped and why (e.g. "no provider files touched").
