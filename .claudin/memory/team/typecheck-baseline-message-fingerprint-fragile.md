---
name: typecheck ratchet phantom "new" errors — fixed 2026-08-07
description: fingerprintDiagnostic hashed tsc's union elaboration, so adding any file re-hashed unrelated diagnostics; elideTruncatedUnion fixes it, and the triage step still applies if one slips through
type: project
---

`bun run typecheck:ci` used to report "N new type errors" in files a branch
never opened. Fixed on 2026-08-07 in `src/tools/TypecheckTool/fingerprint.ts`.

**Cause.** The fingerprint hashes file + code + message. For an error against a
union too large to print, tsc expands ONE arbitrary constituent as the
representative and truncates the rest to `| ... 17 more ... |`. Which member it
picks depends on what else has been interned in the program, so adding an
unrelated file re-words a diagnostic that has not moved.

**Why the obvious fix was not enough.** Eliding the printed type literal leaves
the explanation chain, which is a narrative about that same arbitrary member —
the same diagnostic went from `SDKAssistantMessage` → property `message` →
`Message` to `SDKResultSuccess` → property `usage` → `NonNullableUsage`. Those
are named types and property names. `elideTruncatedUnion` therefore drops the
chain outright for any diagnostic showing a truncated union, and reduces the
union to its (stable) member count.

**Measured**, by adding a two-line file importing `SDKMessage`: 4 phantom
errors before, 0 after, with the unique-fingerprint count unchanged at 2372 of
3161 — no discrimination lost. 16 messages are touched.

**If one still slips through**, the triage is: does the diagnostic reproduce at
the same line on a clean HEAD, and did the TOTAL count move? Unchanged total
plus swapped hashes is a false positive and `bun run typecheck:baseline` is
correct. A moved total is a real error.

See [[bash-filter-sample-corpus-unified]] for the neighbouring habit of
verifying against HEAD rather than trusting a green/red signal.
