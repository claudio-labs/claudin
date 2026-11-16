---
name: dependabot-bumps-2026-11-16-audited
description: Dependabot #354/#355/#356 (2026-11-16) — knip 6.45.1 and the 10-package prod group merged as-is; wrap-ansi 10 merged WITH a zero-width tab sentinel in wrapAnsi.ts
type: project
---

All three merged (squash). Only #356 needed code.

- **wrap-ansi 9.0.2 → 10.0.2 (#356) — merged with a shim.** v10 hard-codes
  `expandTabs` (`TAB_SIZE = 8`, no option), so `Cursor.measureWrappedText` could
  not find the wrapped lines in `this.text`; `Bun.wrapAnsi` keeps a tab as one
  zero-width char. `wrapAnsiNode` in `src/terminal/ink/wrapAnsi.ts` swaps each tab
  for a zero-width sentinel (`U+2060`, else `U+0001`, else `U+200B` — the first
  the input lacks) and puts it back. Probed: `U+2060`, `U+200B`, `U+FEFF`,
  `U+200D`, `U+0001` all reproduce Bun on 9 tab inputs; `U+E000` and `U+FDD0`
  measure 1 and do not. Avoid `U+FEFF` (pasted BOMs) and `U+200D` (joins emoji).
  Break-probes: no shim, first sentinel always, no restore, a non-zero-width
  sentinel — all red. `wrapAnsi.test.ts` also pins "raw wrap-ansi still expands
  a tab": when that goes red, wrap-ansi grew an opt-out, so delete the sentinel.
  Verified under Node: `Cursor.fromText` with tabs, bundled `--target=node`.
  v10 still differs from Bun on nested ANSI (re-opens `\e[1m` per line, Bun drops
  it) and combining marks (v10 keeps `é` whole, Bun and v9 split it) — both in
  v10's favour, not pinned.
- **How it was nearly wrong:** the first pass closed #356 with `@dependabot
  ignore this major version`, judging a shim not worth it; the user asked "não dá
  para arrumar?" and it was. Closing deleted the head branch and blocked
  `gh pr reopen`; recovered with `git fetch origin refs/pull/N/head`, pushing it
  back as the same branch name, then reopen (which also clears the ignore).
- **Production group (#355), no action.** SDK 1.6 → 1.8: new endpoints/models,
  failed-response body in debug logs, `const`/`enum` kept in structured-output
  schemas. bedrock 1.1.2 / vertex 1.1.3 throw `AnthropicError` for a model,
  project or region like `;x` / `..;x` and send `;` as `%3B`; real ids (`@`,
  `:`, `.`) are untouched. commander 15.1 (deprecates `storeOptionsAsProperties`
  and `combineFlagAndOptionalValue`, unused), axios 1.21.1 + follow-redirects
  1.16.3, firecrawl 4.54, google-auth-library 11.3.4, marked 18.2, ws 8.23.
- **knip 6.45.1 (#354), no action.** No baseline refresh needed.
- **Order trap:** #354 and #355 both touch `bun.lock`, so after #354 merged,
  #355 went `DIRTY`. `@dependabot rebase` + a fresh CI run (~7.5 min) fixed it;
  merge one lockfile PR at a time.
- **Trap:** after merging main into a bumped branch, `bun install
  --frozen-lockfile` left axios without its nested `https-proxy-agent` 5.0.1, and
  tests failed with "does not have an export named 'default'" — `bun install
  --force` fixed it (same family as [[incremental-bun-install-misses-nested-deps]]).
