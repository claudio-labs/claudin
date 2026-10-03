---
name: mcp-oauth-presents-claude-code-client-id
description: The MCP OAuth provider defaults clientMetadataUrl to https://claude.ai/oauth/claude-code-client-metadata, so on a CIMD-capable auth server Claudin presents Claude Code's client id — open product decision, kept as is (2026-10-03)
type: project
paths:
  - src/mcp/auth/claudeAuthProvider.ts
---

**Symptom:** Claudin signs in to an MCP authorization server that supports client-ID metadata documents (CIMD).
It identifies itself with Claude Code's metadata document,
`https://claude.ai/oauth/claude-code-client-metadata`, not with its own.

**Where:** `src/mcp/auth/claudeAuthProvider.ts`. Since the opencode port on branch `rewrite` (2026-10-03),
the value sits in one constant, `CLIENT_ID_METADATA_DOCUMENT_URL`.

**Status:** open decision. It is kept for parity on purpose, and pinned by the MCP auth characterization suites. The
user was asked on 2026-10-02 but has not decided yet. It is listed under "Open decisions" in
`docs/tech/rewrite/levers-findings.md` (on `rewrite`).

**Why not fixed:** removing the default might break MCP servers that accept Claudin only because they
take it for Claude Code. Keeping the default is impersonation. That trade-off is the user's to make. The
recommendation on the table is to drop the default and use plain dynamic registration.
