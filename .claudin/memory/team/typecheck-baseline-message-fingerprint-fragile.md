---
name: typecheck ratchet reports phantom new errors when a file is added
description: fingerprintDiagnostic hashes the tsc message, whose union elaboration shifts when unrelated files enter the program — check the total count before hunting the regression
type: project
---

`bun run typecheck:ci` can report "N new type errors" in files your branch
never opened. It is usually not a regression.

`fingerprintDiagnostic` (shared by `scripts/typecheck-ci.ts` and
`src/tools/TypecheckTool/fingerprint.ts`) hashes **file + code + message**,
excluding line and column so an added import does not re-report everything
below it. But for an error against a large union, tsc's message embeds a
truncated elaboration — `{ type: "result"; … } | … 30 more … | { …; }` — and
both the constituent it prints first and the truncation count depend on what
else is interned in the program. Add a file, and a diagnostic that has not
moved gets re-worded, re-hashed, and reported as new.

**Triage:** does the same diagnostic reproduce at the same line on a clean
HEAD (`git archive HEAD | tar -x -C /tmp/x`, symlink node_modules, run the
script there), and did the TOTAL count move? Unchanged total plus swapped
hashes means this, and `bun run typecheck:baseline` is correct. A moved total
means a real error.

Observed twice on 2026-08-07 while adding `src/Tool.types.test.ts`: once on
arrival (2 fingerprints swapped) and again when its import moved from `zod` to
`zod/v4` (3 swapped). Total held at 3161 both times. Affected
`src/cli/print/runHeadless.ts` and `src/utils/hooks/matching.characterization.test.ts`.

Fixing it means normalizing the elaboration out of the message before hashing,
which also changes what the Typecheck tool considers pre-existing — not done,
deliberately. See [[bash-filter-sample-corpus-unified]] for the neighbouring
habit of verifying against HEAD rather than trusting a green/red signal.
