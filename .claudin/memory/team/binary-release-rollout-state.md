---
name: Binary release process — release-binaries.yml + npm OIDC gotchas
description: The single binary-release path (release-binaries.yml, OIDC not NPM_TOKEN) and its durable publish gotchas; rollout is DONE (binaries live since v1.0.1, now v1.0.8+)
type: project
---

**Scope:** this file owns the RELEASE and PUBLISH side — the sole workflow, OIDC,
the privacy gate, publish order and the npm gotchas. How the binaries are built,
assembled, vendored and updated is [[compile-binary-distribution]].

Durable release-process facts for the native-binary distribution. The 2026-07-14 rollout is **complete** — binaries
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
- **`publish-npm.yml` still exists and publishes the ROOT package** — same npm name
  as the assembled wrapper, but the root `package.json` has no
  `optionalDependencies`, so a successful run for a version release-binaries.yml
  never published would point `latest` at a package with no native binaries. Two
  things keep that narrow today: npm refuses to overwrite an existing version, and
  the Trusted Publisher entry names `release-binaries.yml`, so OIDC 404s for this
  workflow. **Do not add a TP entry for `publish-npm.yml` casually**, and prefer
  deleting the workflow over "fixing" it.
- **The privacy gate lives in `prepack`, not in a workflow step** (2026-08-06).
  `prepack` is `build:release && verify:privacy`, so the bundle scanned is the one
  packed. A `build:verified` step before publish would scan a DEV build — minified
  off, sourcemaps on, different chunk names — i.e. certify a bundle that never
  ships. Note `verify-no-phone-home.ts` walks all of `dist/` recursively, so split
  chunks are covered, but the native binaries are NOT (still the open TODO).
- **Release validation gates the `version` job, not `publish`** — `version` commits
  a bump, pushes a tag and opens the GitHub release, so a suite that only ran at
  publish time would still leave a tag for a version that never shipped.
- **npm OIDC cannot do a package's FIRST publish** — npmjs.com requires the package
  to exist before a Trusted Publisher can be configured (unlike PyPI). New platform
  packages must be bootstrapped with a placeholder publish
  (`scripts/release/bootstrap-platform-packages.ts`) before OIDC can take over. If you ever
  add a new `@claudiolabs/claudin-<platform>` name, bootstrap it first, then
  configure TP (provider GitHub Actions, owner `claudio-labs`, repo `claudin`,
  workflow `release-binaries.yml`).
- **Verify-publish**: a freshly published npm package 404s on `npm view` / the public
  registry API for minutes (read-CDN lag), but `npm access list packages
  @claudiolabs` (authenticated) reflects it immediately — use that to confirm.
- **`assemble-packages.ts` hard-fails if ANY of the 8 platform binaries is missing**
  — a flaky `windows-11-arm` / musl-Alpine leg fails the whole release rather than
  shipping a partial wrapper.
- **Publish order is platform-first, wrapper-LAST** — the wrapper's
  `optionalDependencies` pin exact platform versions, so publishing it before its
  legs would point `latest` at a version whose binaries do not exist yet. A bad
  leg must never be able to flip `latest`.
