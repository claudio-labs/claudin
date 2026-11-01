---
name: dependabot-bumps-2026-08-no-code-changes
description: The three August 2026 Dependabot batches (08-03, 08-10, 08-17) needed zero source changes — and the couplings they surfaced: Vertex auth matches google-auth-library's ADC message text, undici h2 knobs go under h2Options, our identity headers outrank the SDK's User-Agent
type: project
---

Three batches, each audited and merged with **no source change** — don't re-audit them:

- **2026-08-03** (#45 dev-deps, #46 production-deps, #47): google-auth-library 10.9.1 → 11.0.0,
  axios 1.18.1 → 1.19.0, @modelcontextprotocol/sdk 1.29 → 1.30, firecrawl-js 4.30.1 → 4.32.0,
  execa 10.0.1.
- **2026-08-10** (#73, `6e36a7c6`): marked 18.0.7 → 18.0.9, undici 8.9.0 → 8.10.0, ws 8.21.1 → 8.21.3.
- **2026-08-17** (#109 dev, #110 production): `@anthropic-ai/sdk` 0.115.0 → 0.117.1 with
  bedrock-sdk 0.32.4, vertex-sdk 0.19.4, foundry-sdk 0.4.3, firecrawl-js 4.32.1,
  google-auth-library 11.0.2; `@types/node` 26.2.0, knip 6.32.2.

What each one taught, which the next bump of the same package will ask again:

- **Vertex auth matches an error string.** `isGoogleAuthLibraryCredentialError`
  (`src/providers/transport/withRetry.ts`) classifies a Vertex auth failure by the ADC message
  `"Could not load the default credentials"`. A google-auth-library release that rewords it
  breaks the classification silently — check the message on every major.
- **One google-auth-library copy.** `@anthropic-ai/vertex-sdk` pins `^10`, which once left a
  nested 10.x beside our v11 while `client.ts` passed a v11 `GoogleAuth` into `AnthropicVertex`.
  `"google-auth-library": "$google-auth-library"` in `package.json` `overrides` keeps one copy,
  the way `@anthropic-ai/sdk` is pinned. The duplicate was never in the `--compile` binary
  (byte-identical across the dedup): measure `stat -c%s` across a rebuild rather than citing
  disk layout as evidence about bundle contents.
- **undici's HTTP/2 knobs moved** (8.10.0): top-level `maxConcurrentStreams`,
  `initialWindowSize`, `connectionWindowSize` and `pingInterval` are `@deprecated` in favor of
  `h2Options.*`; `allowH2` is not. `proxy.ts` passes only `allowH2`/`connections`/
  `keepAliveTimeout`/`pipelining` — a new stream/window/ping knob goes under `h2Options`.
- **The SDK's User-Agent never reaches the wire.** SDK 0.116 hardcodes its UA string, but
  `buildHeaders` applies `defaultHeaders` after it, and `getAnthropicClient` puts
  `buildIdentityHeaders(...)` there, so our identity headers win on every lane — Claudin's
  own everywhere except first-party Anthropic, which keeps the upstream `claude-cli` UA on
  purpose (`src/providers/transport/identityHeaders.ts`; [[defingerprinting-branch-2026-08]]).
  SDK 0.117's message_delta accumulation fix is
  transcript fidelity only here: refusal handling reads `stop_details` off the event.
- **Inert, for the record:** axios 1.19's interceptor change (ours only mutate `config`) and its
  `NO_PROXY` change (`axios.defaults.proxy = false`); marked 18.0.9's parser fixes (`~100` stays
  literal through the `del()` tokenizer override in `src/shared/text/markdown.ts`); ws 8.21.3
  (server-side permessage-deflate; our ws use is client-only).

**How to apply:** a merge does not refresh `node_modules` — run `bun install --force` first
(plain `bun install` misses nested deps) and check the installed versions, or every green
check measures the old tree
([[incremental-bun-install-misses-nested-deps]]). Later batches:
[[dependabot-bumps-2026-08-31-audited]].
