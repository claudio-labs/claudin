---
name: dependabot-bumps-2026-10-19-undici-zstd-node-floor
description: Dependabot #310 — undici 8.12 needs zlib zstd (Node 22.15+), floor raised to 22.19.0; SDK 0.135 imports @opentelemetry/api, which crashed the compiled binary until it was bundled
type: project
---

#310 (11 production deps, 2026-10-19) failed PR CI with all 10 `wirePrefix.e2e`
scenarios at `answered: 0, exitCode: null`: the CLI never answered and was
SIGTERMed at 100 s, with empty stderr.

- **Cause: undici 8.11.2 → 8.12.2.** `lib/interceptor/decompress.js:78` runs
  `createZstdDecompress.bind(...)` at module load. `zlib.createZstdDecompress`
  exists from Node 22.15. PR CI runs `.node-version` = 22.12.0 (the engines
  floor, on purpose), where it is `undefined`: every request failed with
  `Cannot read properties of undefined (reading 'bind')` and the retry loop (11
  attempts) outlived the harness. On Node 24 (a dev box) everything is green.
- **Repro:** `mise install node@22.12.0`, then from the checkout
  `<22.12>/bin/node -e "require('undici')"` throws. With the 22.12 bin first on
  PATH, `bun test src/agent/cache/wirePrefix.e2e.test.ts` reproduces CI (the
  launcher is `#!/usr/bin/env node`). Pinned back to 8.11.2: 11/11 green.
- **Fix:** the floor was raised to 22.19.0, undici's declared `engines`, on the
  Dependabot branch (see [[node-engine-floor-22]] for the places that move).
  Holding undici at 8.11.2 was the other option, and the user turned it down.
  undici had declared `>=22.19.0` since 8.11.2, so 22.12 had sat below its floor
  and only worked by luck. Read a bumped package's `engines` against
  `.node-version`, not against the local Node. Now that undici sets the floor,
  it is the highest production `engines` (commander's is 22.12).
- **Not caused by #310:** `SessionsWebSocket close and reconnect` (3–4 tests,
  5 s timeouts waiting for the close to cross loopback) was red on main's own
  run for #309 too. It passes alone on Node 22.12 and 24, so it is a full-suite
  flake and was left undiagnosed (see [[websocket-sites-latent-bugs]]).
- **SDK 0.135 broke the `--compile` binary, found after the merge.** From 0.134
  the SDK traces natively, and `client.mjs` imports `@opentelemetry/api`
  statically. `scripts/build/build.ts` kept it in `external` for both builds, so
  the standalone binary had a `require` it could not resolve. `-p` then died at
  startup in `enableConfigs` with `getFsImplementation().existsSync` undefined,
  not a "module not found". `--version` still exits 0 (it is a fast path), so
  neither `bun run smoke` nor the release matrix can see this
  ([[release-smoke-only-runs-version]] has the repro). A/B against a mock
  Messages server (2026-10-19): the binary at 869a2f03 answers, HEAD crashes, and
  HEAD without that `external` entry answers. **Fix:** bundle `@opentelemetry/api`
  in both builds, which also stops the Node bundle importing an undeclared
  transitive dep. No release had shipped it, since v1.1.46 predates #310.
  Nothing in `src/` imports OpenTelemetry, and the old `@opentelemetry/*` devDeps
  are gone. `@opentelemetry/api` belongs to the SDK, so it is not ours to remove.
  The other `@opentelemetry/*` entries in `external` name packages that nothing
  imports.
- **Audited, no action:** SDK error classes, retries, timeout, headers and the
  deprecated-model list are unchanged; tracing adds no header without a global
  OTel provider. bedrock/vertex/foundry only gained tracing hooks. undici's
  ProxyAgent, `Agent` and fetch `accept-encoding` are unchanged. execa 10.1.1 now
  validates option types, and every call site passes valid ones. google-auth
  moved to gaxios 8, react and p-map are patches, and zod caps container size
  before parsing elements.

Related: [[dependabot-bumps-2026-09-28-audited]], [[node-engine-floor-22]], [[opentelemetry-devdep-stubbed]] (the decision to bundle it).
