---
name: incremental-bun-install-misses-nested-deps
description: An incremental bun install over an existing node_modules skips newly-nested transitive deps, breaking `bun run build` — CORRECTED 2026-08-31, plain `bun install` is NOT enough, use `bun install --force`
type: project
---

After pulling a Dependabot bump, run **`bun install --force`** when
`node_modules/` already exists.

**CORRECTION (2026-08-31):** the original advice ("a plain `bun install` fixes
it") is wrong. On the axios 1.19.0 → 1.20.0 bump (PR #148) a plain
`bun install` reported `20 packages installed`, left
`node_modules/axios/node_modules/https-proxy-agent` **absent**, and the build
died with the exact same error. `bun install --force` (453 packages
reinstalled, ~1.4 s) materialized the nested `5.0.1` and the build went green.
Bun only lays the nested copy down on a full resolution pass, and a plain
install still takes the incremental path when the lockfile is unchanged.

First observed 2026-08-03 on the axios 1.18.1 → 1.19.0 bump (PR #46), and it
recurs on every axios bump. axios declares
`https-proxy-agent: ^5.0.1` and imports it as a
**default** import (`import HttpsProxyAgent from 'https-proxy-agent'` in
`lib/adapters/http.js`). This repo pins `https-proxy-agent: "9.1.0"` at the top
level, and v9 has only the named export `HttpsProxyAgent` — no default.
`bun.lock` correctly records the nested `axios/https-proxy-agent → 5.0.1`, but
an incremental install over a pre-existing `node_modules` installs the new
axios **without materializing its nested v5**. axios then
resolves to the hoisted 9.1.0 and `bun run build` dies with:

```
error: No matching export in "node_modules/https-proxy-agent/dist/index.js" for import "default"
    at node_modules/axios/lib/adapters/http.js:6:8
```

**Why:** the failure looks like a source/bundler bug, not an install artifact,
so it burns time twice — once on the error itself, once on the plain
`bun install` that does not fix it.

**How to apply:** if `bun run build` fails with a "No matching export … for
import" against a package you did not touch, check
`node_modules/axios/node_modules/https-proxy-agent` (absent = this bug), run
`bun install --force` and rebuild before investigating anything else. CI is
**not** affected — a *fresh*
`--frozen-lockfile` install on a clean checkout does materialize the nested
copy (verified in a temp dir), which is why all five workflows in
`.github/workflows/` can keep the flag. Related:
[[dependabot-bumps-2026-08-03-no-code-changes]],
[[dependabot-bumps-2026-08-31-audited]].
