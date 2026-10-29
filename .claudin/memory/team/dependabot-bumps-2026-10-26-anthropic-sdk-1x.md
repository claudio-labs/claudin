---
name: dependabot-bumps-2026-10-26-anthropic-sdk-1x
description: Dependabot #326 — @anthropic-ai/sdk 1.x changes the wire (anthropic-version 2026-10-21, API key as Bearer, platform SDKs copy the header into the body); client.ts pins what 0.x sent; #325 had already broken Bedrock's body version on main
type: project
---

#326 bumped `@anthropic-ai/sdk` 0.135 → 1.2.0 (2026-10-26). CI stopped at
`typecheck:ci` (11 errors), so the tests never ran there; locally the suite had
3 failures. The real changes are on the wire, and no type error shows them:

- **`anthropic-version: 2026-10-21`** on every request, where 0.x sent
  `2023-06-01`. Claude Code 2.1.311 (the same day) still sends `2023-06-01`
  (its bundled SDK's `buildHeaders`). Bedrock takes 2026-10-21 only from
  Claude 4.7 on, per the Anthropic docs bundled in CC.
- **The API key goes out as `Authorization: Bearer`**, not `X-Api-Key`
  (`apiKeyAuth`). The 3 red tests were this. Gateways that speak the Messages
  API read `X-Api-Key`.
- **bedrock-sdk and vertex-sdk 1.x copy the `anthropic-version` header into the
  body's `anthropic_version`**; 0.x hardcoded `bedrock-2023-05-31` /
  `vertex-2023-10-16`. So **#325 (bedrock-sdk 1.1.0 on core 0.135) already sent
  `"2023-06-01"` to Bedrock on main**, unreleased (v1.1.49 predates it).
- The SDK's no-credential error stopped naming `X-Api-Key`, so `errors.ts`
  showed the raw SDK text instead of "Not logged in · Please run /login".
- Types: `BetaMessageParam` gained `role: 'system'` (optional `content`);
  `temperature`/`top_p`/`top_k` left the params types (still sent through
  spreads in streaming.ts and sideQuery.ts, accepted under the pinned version).
- foundry-sdk 0.6 / vertex-sdk 0.21 declare `sdk <1`; the `overrides` forced 1.x
  under them. Both have a 1.1.0 (`sdk >=1 <2`), bumped with it.

**Fix (landed with #326 on main, d82ac0ac; unreleased as of 2026-10-27):** `client.ts` pins `anthropic-version` per lane
(2023-06-01; `bedrock-2023-05-31` and `vertex-2023-10-16` for those two) and
builds the first-party client as a subclass whose `apiKeyAuth` sends
`X-Api-Key`; `errors.ts` also matches "Could not resolve authentication method".
Pins in `client.test.ts` (one per lane) and `errors.auth.test.ts`, all red
before the fix.

**Verified live** through a recording proxy to api.anthropic.com (OAuth,
2026-10-26): the compiled branch binary's headers equal v1.1.49's except
`x-stainless-package-version`; bodies equal except session ids; a Read→Write→Read
run answered (4×200). A fake API key reached the API as `x-api-key` and got the
same "Invalid API key" on both. Sonnet 5.5, same task on both (responses
recorded): params identical (adaptive thinking, `display: omitted`, effort
high), both thought on turn 2 (194 vs 176 thinking tokens) and replayed the
signed block, and the branch's first request read 12,770 tokens from the cache
the release had written. Bedrock, Vertex and Foundry were checked only
against the mocked fetch in `client.test.ts` — no accounts.

**How to apply:** when Claude Code moves to 2026-10-21, drop the pins together
and re-run the live proxy diff; before that, keep every lane on what CC sends.
Related: [[dependabot-bumps-2026-10-19-undici-zstd-node-floor]],
[[externalized-sdk-copies-instanceof-apierror]].
