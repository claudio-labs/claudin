---
name: trust-dialog-skipped-for-third-party-providers
description: Live on main — for every non-firstParty provider, showSetupScreens skips the trust dialog, the .mcp.json approvals and the external-include warning, then marks the session trusted and applies all env vars
type: project
---

`showSetupScreens` (`src/terminal/interactiveHelpers.tsx`) gates three dialogs on
`usesAnthropicAccountFlow()`, which means `getAPIProvider() === 'firstParty'`:
- the workspace trust dialog;
- the `.mcp.json` server approvals (`handleMcpjsonServerApprovals`);
- the external `CLAUDE.md` include warning.

For every other provider (OpenAI-compatible, Gemini, Codex, Copilot, Bedrock,
Vertex, Ollama and the rest, which is most Claudin users), it skips all three. It
then calls `setSessionTrustAccepted(true)` and
`applyConfigEnvironmentVariables()`, whose own comment says the env can be
dangerous and come from untrusted sources. So a cloned repository's hooks,
settings `env` and helpers are trusted with no prompt.

The comments say the skip exists so the REPL mounts for third-party providers
("frozen terminal"). That is a reason to set session trust after the dialog, not
to skip the dialog.

Found on 2026-10-04 by the `permissions/sessionDialogs` characterization (its
finding 6), and confirmed by reading `main`. It cannot be pinned in a test,
because startup returns early under `NODE_ENV=test`.

**Why:** it is the widest of the project-trust items. The others (repo-set
bypass, self-approved `.mcp.json`, `headersHelper` under `-p`, carve-out
symlinks) all assume the trust dialog stands in front of them.

**How to apply:** the user decided on 2026-10-04 to fix it on the `rewrite`
branch only, together with the rest of the project-trust list, not as a
separate fix on `main`.
- **What the fix does:** show the trust dialog, the MCP approvals and the
  include warning for every provider, and keep `setSessionTrustAccepted(true)`
  after them.
- **How to verify:** run it interactively with an OpenAI-compatible provider,
  from a throwaway cwd.
- **Until the cut:** `main` stays as it is.
