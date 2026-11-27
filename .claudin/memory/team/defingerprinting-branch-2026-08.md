---
name: defingerprinting-branch-2026-08
description: The feat/claudin-identity round stripped upstream identity from wire, bundle, help and env vars — and deliberately left two clusters upstream-spelled
type: project
---

`feat/claudin-identity` (2026-08-15, 12 commits) removed upstream identity along
four axes: network identity, dead Anthropic-account subsystems, the upstream
codename event vocabulary, and the `CLAUDE_*` → `CLAUDIN_*` env-var cut-over. The
mechanics live in the repo — `.claudin/rules/build-system.md` (the codename strip),
`scripts/migrations/env-rename-map.json` (every name, bucket, and reason), and
`src/__tests__/envNaming.test.ts` (the invariant). What is NOT in the repo is
why some things were left alone.

**Two clusters stay upstream-spelled on purpose, and must move as units.**
The agent-identity vars (`CLAUDE_CODE_AGENT_ID`, `_AGENT_NAME`, `_TEAM_NAME`,
`CLAUDE_CODE_PARENT_SESSION_ID`) travel with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`; the `sessionRunner` passthrough set is
bridge/CCR. Both are bucket D — dead in this fork — and the plan deferred
CCR/remote (32 files) and cowork to their own round. Renaming half a cluster is
how an outbound contract ends up inconsistent, so do not "finish" these
piecemeal; they move when their subsystem is removed or revived.

**One lane keeps the upstream User-Agent and session headers on purpose:**
first-party Anthropic OAuth, where the backend inspects them. Gate on
`isFirstPartyAnthropicBaseUrl()`, never on a provider tag — see
[[provider-tag-not-anthropic-includes-cloud]].

**MCP wire identity (found 2026-09-15, decided 2026-11-26).** Both MCP clients
used to announce `description: "Anthropic's agentic coding tool"` and a claude.com
`websiteUrl` to every third-party server. They now share `getMcpClientInfo()`
(`src/mcp/client/clientInfo.ts`), which describes Claudin. `name: 'claude-code'`,
the `claude-code/<ver>` User-Agent and the claude.ai CIMD client id were kept on
purpose, since a server may allowlist on them ([[opencode-mcp-ports]]). The server side was fixed in the same
round: `mcp serve` used to introduce itself as `claude/<codename>`
(`serverInfo.name` in `startMCPServer`, `src/platform/entrypoints/mcp.ts`).

**Deleted outright, do not go looking for them:** `platform/privacy/grove.ts`
plus the `/privacy-settings` command, `platform/settingsSync/`, `mcp/xaa.ts` +
`xaaIdpLogin.ts`, and the homespace/protected-namespace helpers. Grove mattered
because headless `checkGroveForNonInteractive()` could `gracefulShutdown(1)`
telling the user to run `claude`.

Related: [[anthropic-startup-traffic-disabled-default]],
[[mechanical-rewrites-skip-producers]] — the env map was built from names READ
via `process.env`, which is blind to write-only names, and that is exactly how
the outbound contract nearly got skipped.
