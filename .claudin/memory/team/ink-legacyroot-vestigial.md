---
name: LegacyRoot tag is vestigial in react-reconciler 0.33
description: Ink passes LegacyRoot but React 19 compiled legacy mode out — roots run in ConcurrentMode, same-task updates auto-batch into one async commit
type: project
---

react-reconciler 0.33 (React 19) ignores the `LegacyRoot` tag Ink passes at `src/ink/ink.tsx:277` for scheduling purposes: `createContainer` returns a root whose fiber mode has the ConcurrentMode bit set (legacy mode is compiled out of the package). Verified empirically 2026-06-11: a `useSyncExternalStore` notify + a `setState` issued in the same task produce 1 render and 1 commit, flushed asynchronously after the task — i.e. normal React auto-batching, NOT "two separate synchronous commits".

**Why:** two rounds of comments (dfdfe4d3 → 45cd6038 → 20c7f36e) flip-flopped on this; only a probe against the repo's reconciler settled it. `src/ink/render-to-screen.ts:36` still carries the false "LegacyRoot: all work sync, no scheduling" premise (its ConcurrentRoot/flushSyncWork observation may have a different real cause — unverified).

**How to apply:** when reasoning about Ink commit/paint atomicity, assume ConcurrentMode + same-task auto-batching + Ink's throttled stdout paint as a second net. Don't cite LegacyRoot as a sync-rendering guarantee; re-probe before relying on render-to-screen.ts's comment.
