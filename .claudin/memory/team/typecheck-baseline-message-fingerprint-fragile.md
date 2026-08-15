---
name: typecheck ratchet phantom "new" errors — fixed 2026-08-07
description: fingerprintDiagnostic hashed tsc's union elaboration, so adding any file re-hashed unrelated diagnostics; elideTruncatedUnion fixes it, and the triage step still applies if one slips through
type: project
---

**Owns:** the one union-elaboration bug in `fingerprintDiagnostic`, and the
triage to run when a "N new type errors" report is suspected of being phantom.
What a fingerprint is made of and why is [[typecheck-tool-baseline-design]];
reading the backlog and the ratchet is [[typecheck-backlog-shape]].

`bun run typecheck:ci` used to report "N new type errors" in files a branch
never opened. Fixed on 2026-08-07 in `src/tools/TypecheckTool/fingerprint.ts`.

**Cause.** The fingerprint's message component is the fragile one. For an error
against a union too large to print, tsc expands ONE arbitrary constituent as the
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
correct.

**A moved total does NOT mean a real error** — the second cause, seen
2026-08-06 on the dead-code branch. The tool reported "4 new since ee9e125"
while the total went 2849 → 2841, which reads as eight fixed and four
introduced. All four were phantoms: the *stored* baseline for ee9e125 held
fingerprints computed by whatever CLI was running when it was written, so a
baseline recorded before `elideTruncatedUnion` reached the built bundle keeps
producing phantoms against post-fix runs until it is re-recorded. The fix works;
the stale artifact on disk is what lies.

Settle it by fingerprinting BOTH revisions with ONE version of the code, rather
than trusting the stored baseline:

1. `npx tsc --noEmit --pretty false > /tmp/raw.head.txt` on the branch, then the
   same at the base commit into `/tmp/raw.base.txt`. Capture raw output only —
   do not fingerprint yet.
2. Return to the branch, and fingerprint both files with the branch's
   `parseCheckerOutput('tsc', …)` + `fingerprintDiagnostic` (a ~10-line bun
   script). Using the checked-out code for each side is the mistake that
   reintroduces the artifact.
3. `comm -13` the sorted fingerprint sets. Zero new is zero new.

A cheaper pre-check that needed no script and agreed: collapse each diagnostic
to `(file, TS code)`, `uniq -c` both revisions, and look for pairs that are new
or higher. Grepping raw message text does NOT work — it flags the very
union-elaboration churn the fingerprint exists to absorb.

Note this is not the only way machine-specific text reaches a fingerprint: tsc
also quotes absolute checkout paths inside the message, which
[[typecheck-backlog-shape]] covers under the clean-clone trap.

See [[bash-filter-sample-corpus-unified]] for the neighbouring habit of
verifying against HEAD rather than trusting a green/red signal.
