---
name: checkBatchWritePermission returns updatedInput:{} which clobbers the tool's real input
description: Why a tool wiring checkBatchWritePermission as checkPermissions gets {} at call() in auto/bypass mode; apply_patch crash root cause + the empirical-verification lesson
type: project
---

`checkBatchWritePermission` (src/utils/permissions/filesystem.ts) returns `{ behavior:'allow', updatedInput: {} }` on its allow paths (~line 1442 bypassPermissions, ~1512 batch allow). It validates a SYNTHETIC per-path `{file_path}` input, so it has no single real input to echo — `{}` is a placeholder.

The tool-execution harness (src/services/tools/toolExecution.ts ~1142) does `if (permissionDecision.updatedInput !== undefined) processedInput = permissionDecision.updatedInput`, then `callInput = processedInput` → `tool.call(callInput, ...)`. So that empty `{}` OVERWRITES the model's real, schema-parsed input before call().

**Why:** apply_patch wired `checkBatchWritePermission` directly as its `checkPermissions`. In auto mode (and bypassPermissions — the DEFAULT/common modes) every apply_patch call reached `runApplyPatch` with `input = {}`, so `parsePatch(input.patchText)` ran `undefined.trim()` → `TypeError: Cannot read properties of undefined (reading 'trim')`. The tool was 100% DOA at runtime. FileEdit/FileWrite are unaffected: they use the single-path `checkWritePermissionForTool`, whose allow echoes the real input.

**How to apply:** Any tool using `checkBatchWritePermission` as its `checkPermissions` MUST NOT let the `{}` propagate — on `allow`, return `{ ...decision, updatedInput: input }` (echo the tool's real input). Fixed on feat/apply-patch-tool in checkApplyPatchPermissions (src/tools/ApplyPatchTool/applyPatch.ts). checkBatchWritePermission is currently apply_patch-only.

**Test blind spot (reinforces feedback-audit-empirical-test-verification):** all 60 apply_patch unit tests PASSED because they call `runApplyPatch(input, ctx, uuid)` directly with a correct `{patchText}` object, bypassing the schema-parse → permission → backfill → callInput plumbing where the clobber happens. Green tests + green build + green privacy did NOT catch a totally broken feature. Only driving the real app live (claudindev under tmux, real model calling the tool) surfaced it. Tools whose input flows through permission/auto-mode reconstruction need a live/integration check, not just direct-call unit tests.
