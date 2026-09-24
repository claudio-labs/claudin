---
name: waitfor-drops-optional-params
description: WaitFor ignored until/settle_s/interval_s/timeout_s because checkPermissions returned Bash's updatedInput {command}, which the harness applies verbatim — FIXED 2026-09-24 on feat/dev-tools-deferred-advice (Monitor had the same bug)
type: project
paths: src/tools/WaitForTool/**
---

**Symptom (until 2026-09-24).** Every `WaitFor` call returned `settled after ~3.1s, 4 polls`
regardless of what it was asked for — `settle_s`, `interval_s`, `timeout_s` and
`until` behaved as if absent, and `setup` ran on every poll.

**Root cause.** `checkPermissions` returned `bashToolHasPermission({ command }, ctx)`
verbatim. On `allow` that result carries `updatedInput: { command }`, and
`toolExecution.ts` (`if (permissionDecision.updatedInput !== undefined) processedInput = …`)
replaces the tool's whole input with it — so `call()` received only
`{ command: "<setup> && <command>" }`. The same clobber as
[[checkbatchwrite-updatedinput-clobbers-input]]; `MonitorTool.checkPermissions` had
it too (it lost `description`). Only `allow` results carry `updatedInput`, so the
`ask` path was never affected.

**Fix.** Take Bash's `.behavior` only; on allow return
`{ behavior: 'allow', updatedInput: input }` — the shape Build/RunTests/Typecheck
already used. Pinned by a `checkPermissions` test in each tool's suite that
asserts `updatedInput` is the tool's own input object; both go red when the
line is reverted (`scripts/migrations/probes/devToolsDeferredAdvice.json`).

**How to apply:** any tool that delegates `checkPermissions` to another tool's
permission function must echo its own input on allow. The existing
`WaitForTool.test.ts` cases call `call()` directly and could never see this —
the permission path needs its own test.
