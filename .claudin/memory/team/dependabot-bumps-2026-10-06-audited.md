---
name: dependabot-bumps-2026-10-06-audited
description: Dependabot #275/#276 (anthropic sdk 0.131, mcp 1.31, shell-quote 1.11, ws 8.22, firecrawl 4.42, @types/react-reconciler 0.33.1) audited — shell-quote opened a Bash permission bypass, fixed with 2 follow-ups
type: project
---

#276 (12 production deps) and #275 (dev: @types/node, @types/react-reconciler, knip)
landed on main 2026-10-05/06, after the v1.1.40 release. #275 failed `typecheck:ci`
until the reconciler was adapted (commit on that PR: 20 type args, 11th
`createContainer` arg, devtools name/version moved into the host config).

Audit 2026-10-06 diffed old vs new tarballs. Fixes on branch
`fix/shell-quote-ansi-c-and-dep-followups` (3 commits, probes in
`scripts/migrations/probes/shellQuoteAnsiC.json` + `mcpOAuthIssuer.json`):

- **shell-quote 1.10 → 1.11 — the finding.** `parse()` now decodes ANSI-C `$'…'`.
  `splitCommandWithOperators` rebuilds subcommand TEXT from tokens, so
  `$'a\x27b'` came back `'a'b'`; the stray quote swallowed `--output=` and
  `echo hi⏎git diff -G $'a\x27b' --output=PATH -G $'c\x27d'` was auto-ALLOWED (it
  writes PATH). Production takes this path (TREE_SITTER_BASH is not in
  featureFlags). Fix: placeholder for the `$` of `$'`, plus `\n` in the
  obfuscated-flag echo exemption.
- **MCP SDK 1.31:** `auth()` stamps saved credentials with `issuer` and discards a
  mismatch on read; `ClaudeAuthProvider` dropped it (protection inert, a
  `console.warn` per `auth()`, configured `oauth.clientId` copied into storage).
  Now `clientIssuer`/`tokenIssuer` in the entry. `getSecureStorage` gained
  `_setSecureStorageForTesting`, the provider's first behavioral tests.
- **sdk 0.131:** `console.warn` on every request whose model is exactly
  `claude-sonnet-4-5[-20250929]` — Foundry's default id. Anthropic retires it
  2026-11-30 on the Claude API AND Foundry (Bedrock/Vertex: own schedule). Added
  to `deprecation.ts`; the 3P default stays (Claude Code parity) — **the Foundry
  default breaks on 2026-11-30 unless it moves.**
- No action: bedrock/vertex/foundry sdk (upload filename only), ws, firecrawl,
  chalk, ignore (lone `!` pattern now ignored), sharp, supports-hyperlinks (Warp).

Related: [[dependabot-bumps-2026-09-28-audited]].
