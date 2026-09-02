---
name: new-diagnostics notifications can be stale mid-edit snapshots
description: Harness <new-diagnostics> reminders may reference symbols/lines from before the agent finished editing — verify with bun run typecheck before acting
type: feedback
---

When the harness injects `<new-diagnostics>` system-reminders citing missing symbols, unused imports, or unreachable code in xAI/provider files, treat them as **possibly stale**. They're snapshots from an intermediate save during a multi-edit tool sequence, not always the final file state.

**Why:** During the xAI audit-fix pass (commit `4a339d4c`), diagnostics flagged `checkXaiOAuthProfile` as "Cannot find name", `EADDRINUSE_MESSAGE_RE` as undefined, providerProfiles.ts as still referencing removed `xaiAccountId` extras, and useXaiOAuthFlow.ts:78 as unreachable — all of which were already fixed in the on-disk file by the time we acted. Running `bun run typecheck` showed the real error count was identical to the `main` baseline (4320, mostly pre-existing `messagesClient.ts`/`mcp/doctor.ts` noise unrelated to the PR).

**How to apply:**
1. Before chasing a diagnostic listed in a system-reminder, do one read of the cited line OR run `bun run typecheck 2>&1 | grep <file>` to confirm it's still present.
2. Compare against baseline: `bun run typecheck 2>&1 | grep -cE "error TS"` should match `main`'s count (currently ~4320). Anything matching the baseline count means no new regressions, even when diagnostics look alarming.
3. Pre-existing noise to ignore: `messagesClient.ts` "response possibly undefined" (~10 sites), `mcp/doctor.ts` test mismatches, `doctorDiagnostic.ts` MACRO references, `config.ts:1400` implicit any. These are on `main` too.
