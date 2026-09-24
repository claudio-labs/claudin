---
name: batch-read-default-on
description: 2026-09-24 — the batch Read (file_paths, symbol lists) is ON by default, with hooks run per file; CLAUDIN_READ_MULTI=0 is the killswitch
type: project
scope: tools/FileReadTool + platform/lifecycleHooks
impact: functional
paths:
  - "src/tools/FileReadTool/readMulti.ts"
  - "src/tools/FileReadTool/batchRead.ts"
  - "src/platform/lifecycleHooks/hookUnits.ts"
---

**Decision:** Read takes `file_paths` (2–20 absolute paths, no globs) and a
`symbol` list (≤10), every provider. The user promoted it, on condition that
hooks work per file (branch `perf/cat-read-and-batch-read`, c8eb815c).

**Why:** in the session A/B it cut API calls by 3 (−16%) against the baseline
with the placebo moving the other way ([[cat-read-and-batch-read-ab-2026-09-24]]).
With it on, claudin tied Claude Code in the same run. The user's criterion was
"fewer API calls". In real sessions the ceiling is lower: a census of 156
sessions put it at ~1.9% of API calls, because 73% of Read-only messages read
one file.

**What changes for a teammate:**
- Hooks see a batch as the single Reads it makes, one per file and symbol,
  never `file_paths` (`Tool.hookUnits`, `hookUnits.ts`).
  - PreToolUse: any deny denies the call and names the file; asks become one
    ask.
  - PostToolUse and PostToolUseFailure run per file.
  - PermissionRequest and PermissionDenied are combined.
  - A dedup stub gets no PostToolUse, unlike a single Read's.
- Permissions: `checkBatchReadPermission` — a deny on any file denies the call,
  and an ask on any file becomes one ask listing them.
- The call is limited to 25k tokens in total. Files past that are named,
  never shown. Images, PDFs and notebooks need a Read of their own.
- `/resume` rebuilds one entry per file from the `==> path <==` sections
  (`batchResult.ts`).
- The transport tests (`readToolSchema.transports.test.ts`) cover the schema
  on every provider. Not verified live: whether Gemini, Mistral or Ollama
  accept the `{type:"null"}` branch inside `symbol`'s `anyOf`.
- `CLAUDIN_READ_MULTI=0` restores the single-file schema, description and
  dispatch byte for byte.

**Rejected:** keeping the refusal under a Read hook (it made the batch vanish
for anyone with a hook); globs in `file_paths` (0.11% of calls, and I/O before
the permission check).

**Evidence:** runs `/tmp/session-cache-ab/20260924-212723` and `-231111`;
`scripts/bench/ab/read-credit-e2e.ts` scenarios 3–5 (mock model; 20/20 with
the hooks scenario); `scripts/migrations/probes/readMulti.json` (122 probes).
