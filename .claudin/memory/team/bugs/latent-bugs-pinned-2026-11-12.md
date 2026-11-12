---
name: latent-bugs-pinned-2026-11-12
description: Defects the 2026-11-12 characterization suites surfaced in openaiErrorClassification, errors.ts, proxy.ts and openaiModelDiscovery — pinned as current behavior, NOT fixed
type: project
paths:
  - "src/providers/shims/openaiErrorClassification.ts"
  - "src/providers/transport/errors.ts"
  - "src/providers/transport/proxy.ts"
  - "src/providers/model/openaiModelDiscovery.ts"
---

The cover-before-touching suites written for [[sibling-ports-2026-11]] pin today's answers, so fixing one of these means changing its pin in the same `fix(…)` commit.

**openaiErrorClassification.ts** (`openaiErrorClassification.characterization.test.ts`):
- A 502, 503 or 504 with an HTML gateway page is `malformed_provider_response`, `retryable: false`. The malformed check runs before the ≥500 check, so a Cloudflare 502 is never retried.
- `http://[::1]` is not localhost: `URL.hostname` keeps the brackets.
- A route 404 whose body mentions `/models` and "not found" reads as `model_not_found`.
- `input length` matches unrelated prose ("invalid input length for field name"), which becomes `context_overflow`.
- An AbortError reading "This operation was aborted" is a `network_error`, because only the message is checked, not `error.name`.
- A codeless "fetch failed" on localhost is always `localhost_resolution_failed`.

**errors.ts** (`errors.characterization.test.ts`):
- `classifyAPIError` returns `unknown` for "Could not resolve authentication method", while `getAssistantMessageFromError` treats it as a bad key.
- `logToolUseToolResultMismatch` builds two sequences and drops them, running on every request.
- `categorizeRetryableAPIError` calls 409 and 413 `server_error`.

**proxy.ts** (`proxy.characterization.test.ts`):
- `getProxyAgent` is cached by proxy URL only, so a later NO_PROXY, mTLS or CA change is ignored until `clearProxyCache()`.
- `getAddressFamily` defaults to 4.

**openaiModelDiscovery.ts** (`openaiModelDiscovery.test.ts`):
- The prefetch latch locks for the process if the first call runs under a non-openai provider. It returns before the `finally` that clears it.
- A negative `context_length` is shown in the description.
- One non-string `id` throws away the whole page.
- Discovered windows are never cleared.

Still open from before: the LSP client sends `version: 1` on every didChange ([[stale-diagnostics-notifications]]; openclaude fixed it in 9bf1040e).
