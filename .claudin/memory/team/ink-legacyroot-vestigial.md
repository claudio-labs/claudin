---
name: LegacyRoot tag is vestigial in react-reconciler
description: Ink passes LegacyRoot but React 19 compiled legacy mode out — roots run in ConcurrentMode, same-task updates auto-batch into one async commit
type: project
---

react-reconciler ignores the `LegacyRoot` tag Ink passes at `src/terminal/ink/ink.tsx` for scheduling purposes: `createContainer` returns a root whose fiber mode has the ConcurrentMode bit set (legacy mode is compiled out of the package). Verified empirically 2026-06-11 on 0.33: a `useSyncExternalStore` notify + a `setState` issued in the same task produce 1 render and 1 commit, flushed asynchronously after the task — i.e. normal React auto-batching, NOT "two separate synchronous commits". Re-checked on the 0.34 bump (2026-09-14) by reading the package: `FiberRootNode` discards the `tag` argument and assigns `this.tag = 1` unconditionally, so the claim is version-independent — stop pinning it to a reconciler version.

**Why:** two rounds of comments (dfdfe4d3 → 45cd6038 → 20c7f36e) flip-flopped on this; only a probe against the repo's reconciler settled it. `src/terminal/ink/render-to-screen.ts` still carries the false "LegacyRoot: all work sync, no scheduling" premise (its ConcurrentRoot/flushSyncWork observation may have a different real cause — unverified).

**How to apply:** when reasoning about Ink commit/paint atomicity, assume ConcurrentMode + same-task auto-batching + Ink's throttled stdout paint as a second net. Don't cite LegacyRoot as a sync-rendering guarantee; re-probe before relying on render-to-screen.ts's comment.
