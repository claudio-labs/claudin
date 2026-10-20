---
name: opentelemetry-devdep-stubbed
description: Since 2026-10-19 @opentelemetry/api is bundled in both builds, not external; SDK 0.135 imports it and, left external, it crashed the compiled binary. Replaces the 07-08 "keep the OTel devDeps" verdict
type: project
scope: build
impact: structural
paths:
  - "scripts/build/build.ts"
---

**Decision:** `@opentelemetry/api` is dropped from the `external` list in `scripts/build/build.ts`, so Bun bundles it into both the Node bundle and the `--compile` binary. The other `@opentelemetry/*` entries stay external.

**Why:** `@anthropic-ai/sdk` ≥0.134 imports `@opentelemetry/api` statically from `client.mjs`, for native tracing. Left external, the standalone binary carried a `require` it could not resolve, and `-p` died at startup in `enableConfigs`. That failure did not read as "module not found". It was measured on 2026-10-19 against a mock Messages server: the binary built at 869a2f03 answers, #310's binary crashes, and #310 with the package bundled answers ([[dependabot-bumps-2026-10-19-undici-zstd-node-floor]]).

**What changes for a teammate:**
- **Don't put it back in `external`** next to its siblings, which look like the same case and are not.
- **A package in `external` must resolve at runtime.** `bun --compile` has no `node_modules` beside the binary, so any package left in `external` that a bundled dependency imports breaks the binary.
- **Check a dependency bump with a real request.** Run `-p` against a mock, from outside the checkout. `--version` cannot catch this ([[release-smoke-only-runs-version]]).

**Rejected:**
- **Bundling it only for `--compile`:** the Node bundle would then import a transitive dependency that Claudin never declares.
- **Vendoring it beside the binary, like sharp:** it is pure JS, so bundling is enough.
- **Removing it:** it is the SDK's own dependency.

**What it replaces:** the 2026-07-08 verdict to keep the `@opentelemetry/*` devDeps for typecheck. Those devDeps are gone from `package.json`, nothing in `src/` imports OpenTelemetry any more, and the SDK only calls the no-op API, because nothing registers a provider.

**Evidence:** the #310 follow-up session of 2026-10-19; the comment beside `external` in `scripts/build/build.ts`.
