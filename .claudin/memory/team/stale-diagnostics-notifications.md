---
name: new-diagnostics notifications can be stale mid-edit snapshots
description: Harness <new-diagnostics> reminders may reference symbols/lines from before the agent finished editing — verify with bun run typecheck before acting
type: feedback
---

When the harness injects `<new-diagnostics>` system-reminders citing missing symbols, unused imports, or unreachable code in xAI/provider files, treat them as **possibly stale**. They're snapshots from an intermediate save during a multi-edit tool sequence, not always the final file state.

**Why:** During the xAI audit-fix pass (commit `4a339d4c`), diagnostics flagged `checkXaiOAuthProfile` as "Cannot find name", `EADDRINUSE_MESSAGE_RE` as undefined, providerProfiles.ts as still referencing removed `xaiAccountId` extras, and useXaiOAuthFlow.ts:78 as unreachable — all of which were already fixed in the on-disk file by the time we acted. Running `bun run typecheck` showed the real error count was identical to the `main` baseline **as it stood in 2026-06** (4320, mostly pre-existing `messagesClient.ts`/`mcp/doctor.ts` noise unrelated to the PR).

**The alarming shape (2026-09-15): a "file was modified" reminder can show you the
tree mid-`bun run build`.** `preProcessSources` rewrites ~478 files **in place** —
`feature('KAIROS')` → `false`, `logEvent('tengu_x'` → `logEvent(''` — and restores
them in a `finally`. A batch of `Note: <file> was modified … This change was
intentional` reminders landed quoting exactly that folded state: `const bridge =
true`, `if (false)`, `logEvent('' as never, {})`, and `import { feature } from
'bun:bundle'` gone from the top of six files. It reads precisely like a killed
build left the tree preprocessed — the one thing `build-system.md` says to panic
about. It was not: a `Grep` for `feature('BRIDGE_MODE')` and
`logEvent('tengu_concurrent_sessions'` found both intact. **Grep one folded line
before believing it**; do not `git checkout` on the strength of the reminder.

Grep it **twice** if the first answer is zero, though: one `Grep` for
`feature('KAIROS')` in `startupSequence.ts` returned no matches, and a second a
moment later found it at line 392. The window is real but short — the reminders
and the search both raced the build's in-place rewrite. Two disagreeing reads a
few seconds apart mean a build is running, not that the tree is damaged; the
damaged case stays folded no matter how often you look.

**How to apply:**
1. Before chasing a diagnostic listed in a system-reminder, do one read of the cited line, or run the Typecheck tool, to confirm it is still present. This step is the durable half of this memory: a mid-edit snapshot lags the on-disk file regardless of what the error count is.
2. **The baseline is now ZERO.** `tsc --noEmit` reached zero on 2026-08-13 and `typecheck-baseline.json` is `count: 0`, so any error you see is one you introduced — there is no longer a large count to match against. The recipe this file used to give ("compare the count to `main`'s ~4320") and its companion list of pre-existing noise to ignore (`messagesClient.ts` response-possibly-undefined, `mcp/doctor.ts` test mismatches, `doctorDiagnostic.ts` MACRO references, `config.ts:1400` implicit any) are both dead: that noise was fixed, not grandfathered. See [[typecheck-backlog-shape]].
