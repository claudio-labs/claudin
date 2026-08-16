---
name: Externalized bedrock/vertex/foundry SDKs run their own @anthropic-ai/sdk copy — use isSdk* guards, never instanceof
description: SDK error classes must be checked with the isSdk* guards from src/shared/errors.ts; plain instanceof never matches errors from the externalized bedrock/vertex/foundry SDKs
type: project
---

Found 2026-07-03 auditing the @anthropic-ai/sdk 0.109→0.110 bump (123d3bce); FIXED same day.

**Mechanism:** `scripts/build/build.ts` externalizes `@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk` (external list ~line 599) — they load their own `@anthropic-ai/sdk` from node_modules at runtime, while the core SDK is INLINED into the bundle. Errors thrown by those three providers are instances of a *different* class object, so plain `instanceof APIError` (and subclasses) is structurally false for them → they classified as "unknown" (retry/rate-limit/abort handling degraded). Verified empirically cross-copy.

**Fix (2026-07-03):** `src/shared/errors.ts` exports cross-copy guards — `isSdkApiError`, `isSdkApiConnectionError`, `isSdkApiConnectionTimeoutError`, `isSdkApiUserAbortError`, `isSdkAuthenticationError`, `isSdkNotFoundError` — instanceof fast path + prototype-chain constructor-name walk (node_modules copies ship unminified; the bundled copy may be minified, which is why `e.name` string-matching alone was never viable — the SDK doesn't set `this.name`). All ~79 former instanceof sites across 14 files now use the guards. Colocated test: `src/shared/errors.test.ts`.

**Rule going forward:** never write `x instanceof APIError`-family checks — import the matching `isSdk*` guard from `src/shared/errors.ts`. New SDK error subclasses needing checks get a new guard there.

**Lockfile note:** dep bumps of `@anthropic-ai/sdk` can split bun.lock into nested per-package copies (happened at 123d3bce: top-level 0.110.0 + nested 0.109.0 ×3). Guarded now by `"@anthropic-ai/sdk": "$@anthropic-ai/sdk"` in package.json `overrides` (dollar-reference tracks the root dep). If nested copies reappear on disk, `rm -rf node_modules/@anthropic-ai/*-sdk/node_modules` + `bun install`.
