---
name: Binary release process — release-binaries.yml + npm OIDC gotchas
description: The single binary-release path (release-binaries.yml, OIDC not NPM_TOKEN) and its durable publish gotchas; rollout is DONE (binaries live since v1.0.1, now v1.0.8+)
type: project
---

Durable release-process facts for the native-binary distribution (architecture in
compile-binary-distribution.md). The 2026-07-14 rollout is **complete** — binaries
are live (tags v1.0.1 → v1.0.8+ published; `@claudiolabs/claudin@latest` is the
binary wrapper, not the old Node package). What remains durable:

**`release-binaries.yml` is the SOLE release path.** The old Node `release.yml` was
deleted (commit 67b13b1) — it used to publish the legacy Node package to `latest`
and shadow the binary wrapper. Its metadata steps (contributor-credited changelog,
CHANGELOG.md update, claudin-site changelog push) were folded into
release-binaries.yml's `version` job. Publish auth is npm **trusted publishing
(OIDC)** — deliberately NOT NPM_TOKEN (user's explicit CI choice). **Do not propose
NPM_TOKEN.**

**Durable gotchas:**
- **npm OIDC cannot do a package's FIRST publish** — npmjs.com requires the package
  to exist before a Trusted Publisher can be configured (unlike PyPI). New platform
  packages must be bootstrapped with a placeholder publish
  (`scripts/bootstrap-platform-packages.ts`) before OIDC can take over. If you ever
  add a new `@claudiolabs/claudin-<platform>` name, bootstrap it first, then
  configure TP (provider GitHub Actions, owner `claudio-labs`, repo `claudin`,
  workflow `release-binaries.yml`).
- **Verify-publish**: a freshly published npm package 404s on `npm view` / the public
  registry API for minutes (read-CDN lag), but `npm access list packages
  @claudiolabs` (authenticated) reflects it immediately — use that to confirm.
- **`assemble-packages.ts` hard-fails if ANY of the 8 platform binaries is missing**
  — a flaky `windows-11-arm` / musl-Alpine leg fails the whole release rather than
  shipping a partial wrapper.
