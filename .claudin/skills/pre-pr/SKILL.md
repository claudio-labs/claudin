---
name: pre-pr
description: Run Claudin's pre-PR validation gate (build, smoke, typecheck, focused tests, and — when the diff warrants — test:provider and verify:privacy) and report a pass/fail summary. Use before opening or updating a PR.
allowed-tools: Bash
argument-hint: "[path/to/changed.test.ts ...]"
arguments: testPaths
---

# /pre-pr — pre-PR validation gate

Run the checks Claudin expects before a PR and report a concise pass/fail
summary. The full rationale lives in `.claudin/rules/testing.md` (Pre-PR
Checklist) and `.claudin/rules/build-system.md`.

## Steps

Run these in order. Stop and report on the first failure; otherwise continue.

1. **Build** — `bun run build`
2. **Smoke** — `bun run smoke` (build + `--version` sanity)
3. **Typecheck** — `bun run typecheck` (expect zero *new* `tsc` errors; the
   baseline on `main` is ~4320 pre-existing — compare, don't count absolute).
4. **Focused tests** — run the tests for the changed code. If `$ARGUMENTS`
   names test files, run exactly those: `bun test $ARGUMENTS`. Otherwise infer
   the colocated `*.test.ts` next to the files in `git diff --name-only` and run
   those.

## Conditional steps (only when the diff touches these areas)

- **Provider / context** (`src/services/api/*`, `src/utils/context*`):
  `bun run test:provider`.
- **Build / telemetry / network** (`scripts/build.ts`, the bundle plugins,
  anything network-adjacent): `bun run verify:privacy`.
- **Output-format changes**: re-run the affected snapshot tests and confirm the
  `.snap` diffs are intended (`bun test --update-snapshots <file>` only after
  reviewing).

## Reporting

End with a compact table: each check → ✅/❌ and, for any failure, the first
actionable line of output. Do NOT open the PR from this skill — it only
validates. If everything passes, say so plainly and name which conditional
checks were skipped and why (e.g. "no provider files touched").
