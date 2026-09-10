---
name: new-diagnostics notifications can be stale mid-edit snapshots
description: Harness <new-diagnostics> reminders may reference symbols/lines from before the agent finished editing — verify with bun run typecheck before acting
type: feedback
---

When the harness injects `<new-diagnostics>` system-reminders citing missing symbols, unused imports, or unreachable code in xAI/provider files, treat them as **possibly stale**. They're snapshots from an intermediate save during a multi-edit tool sequence, not always the final file state.

**Why:** During the xAI audit-fix pass (commit `4a339d4c`), diagnostics flagged `checkXaiOAuthProfile` as "Cannot find name", `EADDRINUSE_MESSAGE_RE` as undefined, providerProfiles.ts as still referencing removed `xaiAccountId` extras, and useXaiOAuthFlow.ts:78 as unreachable — all of which were already fixed in the on-disk file by the time we acted. Running `bun run typecheck` showed the real error count was identical to the `main` baseline **as it stood in 2026-06** (4320, mostly pre-existing `messagesClient.ts`/`mcp/doctor.ts` noise unrelated to the PR).

**How to apply:**
1. Before chasing a diagnostic listed in a system-reminder, do one read of the cited line, or run the Typecheck tool, to confirm it is still present. This step is the durable half of this memory: a mid-edit snapshot lags the on-disk file regardless of what the error count is.
2. **The baseline is now ZERO.** `tsc --noEmit` reached zero on 2026-08-13 and `typecheck-baseline.json` is `count: 0`, so any error you see is one you introduced — there is no longer a large count to match against. The recipe this file used to give ("compare the count to `main`'s ~4320") and its companion list of pre-existing noise to ignore (`messagesClient.ts` response-possibly-undefined, `mcp/doctor.ts` test mismatches, `doctorDiagnostic.ts` MACRO references, `config.ts:1400` implicit any) are both dead: that noise was fixed, not grandfathered. See [[typecheck-backlog-shape]].
