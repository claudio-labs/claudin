---
name: dependabot-bumps-2026-08-10-no-code-changes
description: The 2026-08-10 Dependabot batch (marked 18.0.9, undici 8.10.0, ws 8.21.3, PR #73) needs zero source changes — audit already done, plus the undici h2Options deprecation to watch
type: project
---

Audited 2026-08-10: PR #73 (`6e36a7c6`, production-deps group) requires **no
source changes**. Validated with `bun install`, `bun run build`,
`bun run typecheck:ci` (0 new, 2820 pre-existing @ baseline 2026-08-07),
`bun run smoke`, `bun run verify:privacy`, and 27 focused tests across
`Markdown.test.tsx`, `markdownTokenCache.test.ts`, `proxy.test.ts`,
`fetchWithProxyRetry.test.ts`, `claudeMdDelta.test.ts`. Don't re-audit.

- **marked 18.0.7 → 18.0.9** — 18.0.8 fixes a *custom checkbox renderer*
  returning `false`; we have no renderer extension. Our only `marked.use()` is
  in `src/shared/text/markdown.ts:41`, a **tokenizer** override (`del()` → `undefined`
  to kill strikethrough so `~100` stays literal). 18.0.9's three parser fixes
  (unmatched `**` run before emphasis, blockquote continuation nesting, pedantic
  `**foo:**`) can change rendered output at the edges. Re-verified live on
  18.0.9: `~100 tokens` stays a plain paragraph, `**foo:** bar` → `<strong>`,
  blockquote continuation stays one paragraph, task-list checkboxes render.
- **undici 8.9.0 → 8.10.0** — the one item worth knowing: the top-level HTTP/2
  knobs `maxConcurrentStreams`, `initialWindowSize`, `connectionWindowSize` and
  `pingInterval` are now **`@deprecated` in favor of `h2Options.*`**
  (`h2Options.settings.initialWindowSize` for the window one). `allowH2` itself
  is **not** deprecated. `src/services/api/proxy.ts` (`ProviderPoolConfig`, ~line 297)
  only passes `allowH2`/`connections`/`keepAliveTimeout`/`pipelining`, and
  `scripts/profile/undici-pool-bench.ts` only `allowH2` — so nothing to change
  today. **Apply when tuning h2:** put any new stream/window/ping knob under
  `h2Options`, never at the top level. Also new in 8.10.0 and inert for us:
  `no_proxy` now matches bare IPv6, cache goes inert on a Client/Pool without
  `opts.origin`.
- **ws 8.21.1 → 8.21.3** — 8.21.2 is test-only; 8.21.3 makes the *server* reject
  a permessage-deflate offer whose `client_max_window_bits` is below the
  configured `clientMaxWindowBits`. Inert here: nothing in the repo sets
  `perMessageDeflate`/`*MaxWindowBits`, and our ws use is client-side
  (`src/services/voiceStreamSTT.ts`, `src/services/mcp/mcpWebSocketTransport.ts`,
  `src/cli/transports/WebSocketTransport.ts`).

**Superseded 2026-08-14:** this note used to flag that `.github/dependabot.yml`
only watches `directory: "/"`, leaving the nested `vscode-extension/claudin-vscode/`
package unbumped. That directory was deleted (the fork no longer ships a VS Code
extension), so `/` is now the only manifest and the gap is closed. Re-add a second
`bun` entry only if another nested `package.json` appears.

See [[dependabot-bumps-2026-08-03-no-code-changes]] for the previous batch and
[[incremental-bun-install-misses-nested-deps]] for the install footgun.
