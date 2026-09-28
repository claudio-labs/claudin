---
name: dependabot-bumps-2026-09-28-audited
description: Dependabot #263/#264 (sdk 0.128, undici 8.11.2, smol-toml 1.9, ignore 7.0.10, marked 18.0.14, mcp 1.30.1, knip 6.38) audited — one real finding, NO_PROXY axios/undici drift, fixed
type: project
---

#263 (dev: @types/node, knip 6.38) and #264 (13 production deps) landed on main
2026-09-28. Full gate run after `bun install --force`: build, smoke, typecheck 0,
`typecheck:ci`, `verify:privacy`, `verify:sdk-types`, `verify:rules`, the three
deadcode gates, `bun test` 13,289 pass / 0 fail. Only one bump needed code.

- **undici 8.10.2 → 8.11.2 — the finding.** 8.11.0 changed EnvHttpProxyAgent's
  NO_PROXY rules: `*` anywhere in the list (`localhost,*`, ` * `) bypasses all,
  `*:80` bypasses one port, `*.example.com` matches subdomains only (never the
  apex), `host:port` also covers subdomains on that port. The axios path
  (hooks, OAuth, `createAxiosInstance`) decides with `shouldBypassProxy` in
  `src/providers/transport/proxy.ts`, which claimed to align with undici but
  never handled `*.x`, `*` in a list, `*:port` or bare `::1`. Rewritten to
  mirror undici's `#parseNoProxy`/`#shouldProxy`, pinned by a 26-row table in
  `proxy.test.ts` (7 went red on the old code). `getProxyAgent` also passed
  `NO_PROXY || no_proxy`, the reverse of `getNoProxy()` and undici — now
  `getNoProxy()`. The SSRF guard in `execHttpHook.ts` was never exposed: the
  hook POSTs through axios, whose interceptor calls the same function.
  No GHSA in this range — the ones search results attribute to 8.11.0 were
  already fixed at 8.10.2.
- **Parity check recipe:** `import 'undici'` dies under Bun
  (`webidl.util.markAsUncloneable is not a function`). Import
  `lib/dispatcher/env-http-proxy-agent.js`, `lib/dispatcher/dispatcher.js` and
  `lib/api/index.js`, `Object.assign(Dispatcher.prototype, api)`, point the proxy
  at a dead port and a local `Bun.serve` target: 200 = direct, error = proxied.
  54 NO_PROXY×URL combinations, 0 mismatches.
- **@anthropic-ai/sdk 0.126 → 0.128:** pagination exports became type-only
  (tsc would flag a value import — none), `anthropic-beta` joins with `,` and no
  space (we never parse it back), no retry of stream/iterator bodies. bedrock-sdk
  0.33.7 now raises APIError on mid-stream error frames — an improvement for the
  name-based guards in `src/shared/errors.ts`.
- **smol-toml 1.9:** fixes DoS GHSA-r4xh-jqrq-34v2; `parse()` returns
  **null-prototype** objects. Sole consumer is `readTomlFile` in
  `src/platform/import/translate/readConfig.ts` → `asTable` only checks
  `typeof`; nothing calls `hasOwnProperty`/`instanceof Object` on the result.
- **ignore 7.0.10:** multi-wildcard patterns (`f*o/*/x`) now match what
  `git check-ignore` matches — a fix that can widen rule `globs:`/skill `paths:`.
- **marked 18.0.14:** six lexer edge cases (setext indent, numeric entities,
  GFM autolinks…); render tests green. **@modelcontextprotocol/sdk 1.30.1:**
  4 MiB body / 100-message batch cap is on the HTTP *server* transport — client
  unaffected. **knip 6.38:** no new findings (exports ratchet 9 below baseline).
  firecrawl 4.41 still has no per-version changelog.

Related: [[dependabot-bumps-2026-09-07-audited]],
[[incremental-bun-install-misses-nested-deps]].
