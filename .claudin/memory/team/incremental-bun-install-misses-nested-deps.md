---
name: incremental-bun-install-misses-nested-deps
description: An incremental `bun install --frozen-lockfile` over an existing node_modules skips newly-nested transitive deps, breaking `bun run build` — run a plain `bun install` after pulling dependency bumps
type: project
---

After pulling a Dependabot bump, run a plain `bun install` — **not**
`bun install --frozen-lockfile` — when `node_modules/` already exists.

Observed 2026-08-03 on the axios 1.18.1 → 1.19.0 bump (PR #46). axios 1.19.0
added a new runtime dependency `https-proxy-agent: ^5.0.1` and imports it as a
**default** import (`import HttpsProxyAgent from 'https-proxy-agent'` in
`lib/adapters/http.js`). This repo pins `https-proxy-agent: "9.1.0"` at the top
level, and v9 has only the named export `HttpsProxyAgent` — no default.
`bun.lock` correctly records the nested `axios/https-proxy-agent → 5.0.1`, but
an *incremental* `--frozen-lockfile` install over a pre-existing `node_modules`
installed axios@1.19.0 **without materializing its nested v5**. axios then
resolved to the hoisted 9.1.0 and `bun run build` died with:

```
error: No matching export in "node_modules/https-proxy-agent/dist/index.js" for import "default"
    at node_modules/axios/lib/adapters/http.js:6:8
```

**Why:** the failure looks like a source/bundler bug, not an install artifact,
so it burns time. Bun's hoisted layout only lays down the nested copy on a full
resolution pass.

**How to apply:** if `bun run build` fails with a "No matching export … for
import" against a package you did not touch, run a plain `bun install` and
rebuild before investigating anything else. CI is **not** affected — a *fresh*
`--frozen-lockfile` install on a clean checkout does materialize the nested
copy (verified in a temp dir), which is why all five workflows in
`.github/workflows/` can keep the flag. Related: [[dependabot-bumps-2026-08-03-no-code-changes]].
