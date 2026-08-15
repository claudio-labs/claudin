// When a per-provider undici.Agent is attached via fetchOptions.dispatcher,
// the request MUST be routed through undici's own fetch implementation.
// Node 24+ ships with an embedded undici that may differ in major version
// from the `undici` package we install — passing an undici-8 Agent to the
// embedded undici-7 fetch crashes with `UND_ERR_INVALID_ARG invalid
// onRequestStart method` because their handler protocols diverged.
//
// pickFetch routes:
//   - dispatcher present AND inner is the original globalThis.fetch  →
//       undici.fetch (matches the Agent's undici version, so the handler
//       contract is honored)
//   - otherwise (no dispatcher, or fetch was overridden — e.g. test mock,
//     SDK custom fetch) → return inner unchanged. This is critical for
//     tests that replace globalThis.fetch with a mock: we MUST honor the
//     mock instead of bypassing it with a real-network undici.fetch.
//
// `inner` is the fallback caller-provided fetch (typed loosely because both
// globalThis.fetch and the Anthropic SDK's Fetch type differ in surface).

import type * as undici from 'undici'

// `FetchLike` unifies the signatures of `globalThis.fetch`, the Anthropic
// SDK's `Fetch` type, and `undici.fetch`. They differ only in optional
// fields on RequestInit/Response (e.g. SDK adds `dispatcher`) and accept
// the same Request/URL/string union for input. Typing as `unknown` at the
// boundary + casting at call sites would force every caller to re-assert
// — the practical signature here is the lowest common denominator.
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>

// Snapshot the pristine globalThis.fetch at module load. If the current
// globalThis.fetch is no longer this reference, something (a test, a mock,
// or user code) replaced it — honor the replacement instead of bypassing.
// eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
const ORIGINAL_GLOBAL_FETCH: FetchLike = globalThis.fetch as FetchLike

let cachedUndiciFetch: FetchLike | undefined

function getUndiciFetch(): FetchLike {
  if (cachedUndiciFetch) return cachedUndiciFetch
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const u = require('undici') as typeof undici
  cachedUndiciFetch = u.fetch as unknown as FetchLike
  return cachedUndiciFetch
}

export function pickFetch(
  init: { dispatcher?: unknown } | undefined,
  inner: FetchLike,
): FetchLike {
  if (!init?.dispatcher) return inner
  // Only swap to undici.fetch when NOBODY has replaced globalThis.fetch.
  // A replaced global (test mock, SDK fetch override) means a caller wants
  // to intercept — bypassing it with undici.fetch would hit the real network.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  if (globalThis.fetch !== ORIGINAL_GLOBAL_FETCH) {
    return inner
  }
  return getUndiciFetch()
}
