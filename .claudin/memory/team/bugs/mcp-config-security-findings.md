---
name: mcp-config-security-findings
description: mcp/config pinned findings — adding a server writes ${TOKEN} placeholders back expanded into .mcp.json; a broken managed-mcp.json lifts the policy; name lookup ignores approval/deny; the .mcp.json walk passes the repo root
type: project
---

Found by the `mcp/config` characterization on 2026-10-03, branch `rewrite`. All
of it is pinned in `src/mcp/config.*.characterization.test.ts`.

**Marked fix.** These land with the `mcp/config` rewrite:
- **Secrets written back.** Adding or removing a project server writes the
  other entries back expanded, so `${TOKEN}` in `.mcp.json` becomes the secret
  itself, on disk, in a file that is often committed.
- **File wiped.** Adding a server to a `.mcp.json` that doesn't parse empties it.
- **Empty server name.** An empty name is accepted.
- **URL pattern case.** URL patterns compare case-sensitively.

**Marked keep and track.** These are security decisions still to make:
- **Name lookup.** A lookup by server name ignores approval, the deny policy and
  the disabled list. Agents connect through that lookup.
- **Broken managed file.** A `managed-mcp.json` that doesn't parse lets every
  other scope back in, instead of failing closed.
- **The `.mcp.json` walk.** It goes above the repo and home. Non-interactive
  sessions auto-approve what it finds.
- **URL patterns and `/`.** In a URL pattern, `*` crosses `/`.
- **Command and name denies.** They can be stepped around with an exact array or
  with a rename.

**Why:** `.mcp.json` decides which commands run as MCP servers from a checkout.

**How to apply:** take the "keep and track" items together with
[[mcp-server-name-folding-reaches-other-servers-rules]] when the approval units
land. Failing closed on a broken managed file is the cheapest win.

**mcp/auth (2026-10-03).** Pinned, not fixed:
- `claudin -p` runs a project's MCP `headersHelper` command without the
  workspace-trust check that interactive mode applies. A cloned repo's
  `.mcp.json` can name the command.
- Trust is granted to the whole workspace at once, not per helper command.

**mcp/doctor.** Same pattern: piped runs (`--json | jq`, CI) start every
`.mcp.json` server that has not been rejected. That includes servers from a
parent directory, and servers nobody approved.

Both belong with the project-scope trust fix. Tracked in the auth and doctor
specs.

**mcp/connection, capabilities, callTool (2026-10-04).** Pinned and tracked:
- **Session ingress token.** It is sent as a Bearer token to any `ws` server, and to any `http`
  server that has no stored token, whatever the host.
- **The `ide` server name skips the tool-output size limit.** Any configured server can take that
  name.
- **`CLAUDIN_SHELL_PREFIX` gets the command unquoted.** It is joined to its arguments with spaces.
- **Oversized output can reach the model whole.** Truncation needs a token count, so on a provider
  with no counting endpoint, or when the count fails, the output goes in uncut.
- **Client identity.** The client identifies itself to every server as `claude-code`, with
  Anthropic's description.

Queued for the rewrite (fixes):
- `persistBinaryContent` does not check the id it is given.
- Two calls to the same tool in the same millisecond collide on the saved-output name.
