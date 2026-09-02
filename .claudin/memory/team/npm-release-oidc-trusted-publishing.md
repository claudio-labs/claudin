---
name: npm release + publish via OIDC trusted publishing
description: release.yml is the one manual npm release flow (bump→artifacts→changelog→GitHub release→npm publish); publishing uses npmjs.com Trusted Publishing (OIDC), NOT an NPM_TOKEN
type: project
---
The @claudiolabs/claudin npm package publishes from GitHub Actions via npm Trusted Publishing (OIDC), configured on npmjs.com — there is intentionally NO NPM_TOKEN secret. Wired 2026-07-09 (commit ab27192) after the 2026-07-08 Gitea→GitHub Actions migration.

**Why:** the user set up a Trusted Publisher on npmjs.com for repo claudio-labs/claudin + workflow release.yml; OIDC short-lived tokens replace long-lived npm tokens and auto-generate provenance. The migration ported the workflows but not the secrets, so a token-based publish would have failed anyway.

**How to apply:**
- `release.yml` (workflow_dispatch, bump = none/patch/minor/major) is the canonical release: bumps package.json, builds artifacts, diffs the changelog, creates the GitHub release (+ mirrors the changelog to claudio-labs/claudio when GH_CHANGELOG_TOKEN is set), then `npm publish`es. A patch bump increments from package.json (0.7.2 → 0.7.3 as of 2026-07-09).
- OIDC requirements already wired into the workflows: `permissions: id-token: write`, an `npm install -g npm@latest` step (trusted publishing needs npm ≥ 11.5.1; Node 22 ships 10.x), and NO NODE_AUTH_TOKEN/NPM_TOKEN. Do NOT re-add a token.
- The Trusted Publisher "environment" field must stay blank — release.yml uses no GitHub Environment; setting one makes npm 404 the OIDC token. Fields are case-sensitive.
- package.json has repository/homepage/bugs pointing at github.com/claudio-labs/claudin so the URL matches the Trusted Publisher (needed for provenance, avoids 404).
- `publish-npm.yml` (manual per-tag publish) is redundant with release.yml and needs its OWN Trusted Publisher entry (filename publish-npm.yml) before it can publish, else 404.
