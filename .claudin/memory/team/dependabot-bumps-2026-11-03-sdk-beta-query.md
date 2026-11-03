---
name: dependabot-bumps-2026-11-03-sdk-beta-query
description: Dependabot #339 — @anthropic-ai/sdk 1.3.0 dropped ?beta=true from the beta endpoints (an internal __qualifiers field instead); client.ts puts it back on the first-party lane; the rest of #338/#339 audited, no action
type: project
---

#339 (2026-11-03) bumped `@anthropic-ai/sdk` 1.2.0 → 1.3.0. CI was green; the
change is on the wire, where no test looked:

- **The beta endpoints lost `?beta=true`.** 1.3.0 posts `beta.messages.create`
  and `countTokens` to bare `/v1/messages` and `/v1/messages/count_tokens`,
  marking them with `__qualifiers: { beta: 'true' }` (untyped in the `.d.ts`),
  which only the SDK's own middleware reads. Claude Code 2.1.316 still sends
  `messages?beta=true` (5 hits in its binary, no `__qualifiers`).
  `client.test.ts` only called the non-beta `client.messages.create`, so nothing
  pinned the beta URL.
- **Fix (branch `fix/sdk-beta-query`, unmerged as of 2026-11-03):**
  `AnthropicWithApiKeyHeader.prepareOptions` sets `query.beta = 'true'` when the
  qualifier is there. A query, not a path suffix: `prepareOptions` runs again on
  every retry, and a suffix doubles (`?beta=true%3Fbeta%3Dtrue`). Pins in
  `client.test.ts`, probes in `scripts/migrations/probes/sdkBetaQuery20261103.json`.
  The built CLI against a logging mock sent `POST /v1/messages` before the fix
  and `POST /v1/messages?beta=true` after.
- **Not restored:** Copilot native (plain `new Anthropic`) and Foundry
  (`AnthropicFoundry`) lost the query too. Bedrock and Vertex match both paths
  and delete `beta` anyway.

Audited, no action:
- axios 1.21.0: the header-defaults change and the `proxyEnv` rejection miss
  `proxy.ts` (`proxy: false` + HttpsProxyAgent, no `proxyEnv`). firecrawl pins
  axios `1.20.0` exactly, so the bundle carries both; the 1.20 copy sits in
  firecrawl's lazy chunk.
- ignore 7.0.14: `/**` and `***` follow git now; `ignores()`, what the
  permission rules call, answered the same on globstar probes.
- google-auth-library 11.3.2 `console.warn`s on `keyFilename`/`credentials`;
  none of our three `new GoogleAuth` pass either.
- MCP SDK 1.32.2, marked 18.1.2, xss 1.0.17, gcp-metadata 9.2.3 (drops
  gaxios 7), knip 6.44, @types/node: fixes only.
- An incremental `bun install` dropped `axios/node_modules/https-proxy-agent`
  again (build: "No matching export"); `--force` fixed it
  ([[incremental-bun-install-misses-nested-deps]]).

**How to apply:** drop the override with the #326 pins when Claude Code moves
to SDK 1.3+ ([[dependabot-bumps-2026-10-26-anthropic-sdk-1x]]). Before an SDK
bump merges, diff the resources' request paths, not only `client.mjs`.
