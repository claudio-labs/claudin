---
name: opencode-integration-protocols-dropped
description: Four integration protocols opencode has and Claudin does not — phone push with pairing, an out-of-process plugin RPC, a PTY daemon, an ssh-askpass relay — REJECTED 2026-11-28 with the reason for each; ACP (dropped 11-12) has grown since and would now cost more
type: project
scope: platform, plugins, sessions, vcs
impact: rejected
---

**Decision:** none of the four is ported (user, 2026-11-28). They were scouted against `../opencode`
@ `449c128a5b` together with the LLM wires, which were ported ([[provider-wire-protocols-2026-11]]).

**Why:**
- **Push to a phone, with pairing codes** (`packages/core/src/push/`, `packages/server/src/pairing.ts`,
  `specs/v2/push.md`): it needs a long-lived server, opencode's hosted relay (origins hard-coded in
  `push/list.ts:84`) and a phone app. A hosted relay is a third-party sink the no-phone-home rule
  forbids.
- **Plugin RPC** (`packages/schema/src/rpc.ts`, HTTP `POST /api/rpc/:rpcID/:method`): a contract for
  plugin code running in the server. Claudin plugins load no code. They contribute commands, agents,
  hooks, MCP and LSP servers, which already run out of process, with MCP as the RPC.
- **PTY daemon** (`packages/process-daemon/`, Rust + libghostty, owner/observer sockets): background
  commands that outlive a restart. `/daemon` was already dropped with the CC 2.1.323 port
  ([[cc-2-1-323-commands-port]]).
- **ssh-askpass relay** (`packages/cli/src/ssh-askpass.ts`, loopback TCP + token): only the desktop
  app's own ssh spawns use it. Claudin turns git prompts off (`src/vcs/git/noPromptEnv.ts`), and Bash
  children have no tty, so a prompt fails fast instead of hanging.

**What changes for a teammate:** a port analysis of opencode can skip these four unless the reason
changed. For push, point users at a `Notification` hook of `type: command` aimed at their own ntfy. A
PTY daemon, if ever asked for, would reuse the peer-inbox socket pattern (`src/sessions/peers/inboxServer.ts`).

**Rejected:** all four, as above. **ACP** stays dropped (11-12, [[sibling-ports-2026-11]]), but it has
grown since: protocolVersion 1 with session list/resume/fork/close/delete, form elicitation, config
options and a `_session/steering` extension (`packages/cli/src/acp/service.ts:144-158`). Reopening it
costs more than it did.

**Evidence:** the 2026-11-28 scout (four Explore agents over `../opencode` and `src/`), the plan
`.claudin/plans/adaptive-snuggling-castle.md` § F.
