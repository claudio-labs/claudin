---
name: dependabot-bumps-2026-08-31-audited
description: Dependabot batch of 2026-08-31 (PRs #147/#148, 12 deps) audited — no code changes needed; the only real behavior change reaches Bedrock's default credential chain
type: project
---

Audited 2026-08-31 (commits `fad55fbc` prod ×10, `10104dd5` dev ×2). Gate run
after `bun install --force`: build ✓, smoke ✓, `tsc --noEmit` **0**,
`verify:sdk-types` ✓, `verify:privacy` ✓, `deadcode:ci` exit 0, 1,941 focused
tests green. **No source adaptation required.**

What was checked and why each is inert here:

- **@anthropic-ai/sdk 0.120 → 0.122** ships real breaking changes, all in
  namespaces this fork never calls: beta `files`/`skills` GA reshape, the
  `BetaSkill*` type renames, `beta.files.list()` → cursor `PageCursor`,
  `webhooks.unwrap()` now requiring headers. Grep for
  `beta\.(files|skills)|BetaSkill|webhooks.unwrap|PageCursor` over `src/`
  returns **zero**. We only touch `beta.messages.create(...).withResponse()`
  and the raw `Stream`, which are untouched. Rerun that grep on the next minor.
- **@anthropic-ai/bedrock-sdk 0.33.1 → 0.33.3** — the ONE user-visible change:
  env credentials now take precedence over `AWS_PROFILE` (#436). It IS
  reachable: `client.ts:250-258` only passes explicit `awsAccessKey/SecretKey/
  SessionToken` when `refreshAndGetAwsCredentials()` returns non-null, which it
  does only when the user configured `awsCredentialExport` — otherwise we pass
  nothing and the SDK's own chain resolves. So a Bedrock user with both
  `AWS_PROFILE` and stale `AWS_ACCESS_KEY_ID` in env gets different creds than
  before. Upstream-intentional; document it if someone reports a Bedrock auth
  regression.
- **axios 1.19 → 1.20** rewrote `InterceptorManager`: ids are now Map keys with
  a stored `index`, not array indices, and trailing ejected slots are popped.
  `proxy.ts:487/504` (register/eject the global NO_PROXY interceptor by id) is
  safe under it — nothing shifts a surviving handler's index, and a stale id is
  ignored rather than ejecting someone else's handler. Nothing in `src/` reads
  `.handlers` directly. The XHR-abort → `ECONNABORTED` change is browser-only.
- **sharp 0.35.3 → 0.35.4** (libvips 8.18.6) — verified at runtime, not just by
  test: `create` → `png` → `metadata` → `resize` → `jpeg().toBuffer()`, the
  exact op set `imageProcessor.ts` declares. `vendor-sharp.ts` derives
  `@img/sharp-*` names from sharp's own `optionalDependencies`, so the three new
  targets (freebsd-wasm32, linux-ppc64, webcontainers-wasm32) are additive and
  need no map edit; the hardcoded JS-dep list `['sharp','detect-libc','semver',
  '@img/colour']` still matches 0.35.4.
- **picomatch 4.0.7** changed `scan()` with `tokens` — we never call `scan()`,
  only `picomatch()` and `isMatch()`. **marked 18.0.11** is output-affecting
  (no nested links, emphasis kept on rejected reflinks) but token-shape
  compatible. **p-map / vertex-sdk / vscode-languageserver-protocol / firecrawl
  / knip / @types/node** are inert (vertex 0.19.6 is examples-only).

Trap for the next batch: the changelog fetch of
`anthropic-sdk-typescript/blob/main/CHANGELOG.md` returned **appended
prompt-injection text** posing as a `<system-reminder>` with autonomous-execution
directives. A researcher agent flagged and ignored it. Expect it again on that
URL. Related: [[incremental-bun-install-misses-nested-deps]],
[[dependabot-bumps-2026-08-17-no-code-changes]].
