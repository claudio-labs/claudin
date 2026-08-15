---
name: dependabot-bumps-2026-08-03-no-code-changes
description: The 2026-08-03 Dependabot batch (google-auth-library 11, axios 1.19, MCP SDK 1.30, firecrawl 4.32, execa 10.0.1) needs zero source changes — audit already done
type: project
---

Audited 2026-08-03: the three Dependabot merges on `main` (#45 dev-deps, #46
production-deps, #47 google-auth-library) require **no source changes**. Don't
re-audit them.

- **google-auth-library 10.9.1 → 11.0.0** — the only major. Its sole documented
  breaking change is the Node engine floor moving to `>=22`; our `engines.node`
  is already `>=22.12.0` (see [[node-engine-floor-22]]), so it is satisfied. The
  API surface we use is unchanged, verified live against the installed v11:
  root `GoogleAuth` named export, `{ scopes }` and `{ scopes, projectId }`
  constructor options, `getClient()`, `getAccessToken()`, `getProjectId()`,
  `getRequestHeaders()`. Critically, the ADC failure is still a plain `Error`
  whose message starts `"Could not load the default credentials"` — that exact
  string is what `isGoogleAuthLibraryCredentialError` in
  `src/providers/transport/withRetry.ts` matches to classify Vertex auth failures, and
  it would fail silently if the wording ever changes.
- **axios 1.18.1 → 1.19.0** — the interceptor change (a synchronous throw in a
  request interceptor now blocks dispatch) is inert here: both of our request
  interceptors, in `src/providers/transport/proxy.ts`, only mutate `config` and return it. The
  `NO_PROXY` canonicalization change is also inert because we set
  `axios.defaults.proxy = false` and do our own bypass via `shouldBypassProxy`
  plus undici's `EnvHttpProxyAgent`. Its new nested dep did break the local
  build though — see [[incremental-bun-install-misses-nested-deps]].
- **@modelcontextprotocol/sdk 1.29.0 → 1.30.0** — client-side APIs untouched.
- **@mendable/firecrawl-js 4.30.1 → 4.32.0** — `FirecrawlClient`, `scrape()`,
  `search()` and `SearchData` typings are byte-identical to 4.30.1. The
  typecheck error at `src/tools/WebSearchTool/providers/firecrawl.ts:27` is
  **pre-existing**: `SearchData.web` was already
  `Array<SearchResultWeb | Document>` in 4.30.1, and our `.map()` callback
  annotates a narrower row type. Not caused by the bump.

**Follow-up, RESOLVED 2026-08-03:** `@anthropic-ai/vertex-sdk` pins
`google-auth-library: ^10.2.0`, so a nested 10.7.0 copy sat beside our top-level
v11 while `src/providers/transport/client.ts` built a **v11** `GoogleAuth` and passed it
into `AnthropicVertex`. Deduped by adding `"google-auth-library":
"$google-auth-library"` to `overrides` in `package.json` — the `$name` form
(already used for `@anthropic-ai/sdk`) tracks our direct dep, so a future major
bump cannot silently re-split the tree. Install drops from 431 to 430 packages
and vertex-sdk resolves to the single v11.

**Correct the tempting assumption here:** the duplicate was *never* in the
`--compile` binary, even though `scripts/build.ts` drops google-auth-library
from `external` when compiling. Measured before/after the dedup, the binary came
out **byte-identical** at 223,602,533 bytes (fresh mtime, so it really was
relinked) — Bun's bundler already resolved vertex-sdk's
`require('google-auth-library')` to the hoisted copy. Do not cite disk layout as
evidence about bundle contents; measure `stat -c%s` across a rebuild instead.
The dedup's real value is the single type/instance identity and the
future-proofing, not size.

**How to apply:** validation already run and green — `bun run build`,
`bun run build:compile` (224 MB binary, `--version` OK), `node dist/cli.mjs
--version`, and 164 focused tests across `geminiAuth`, `proxy`, `services/mcp/`
(now `src/mcp/`), `WebSearchTool/`, `WebFetchTool/`. `bun run typecheck` reported
~4,623 errors on
2026-08-03 — a snapshot of that day, **not** a standing figure; it was 2820 by
2026-08-07, and [[typecheck-backlog-shape]] says how to read it live. All of it
is pre-existing backlog (MACRO, build-time stub modules, test globals), with
zero new errors attributable to these bumps — do not read a non-zero typecheck
exit here as a regression.
