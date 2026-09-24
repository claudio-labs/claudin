---
name: cross-session-messaging
description: SendMessage reaches subagents, "main" and other local Claudin sessions over owner-only unix sockets since 2026-09-24; Claudin↔Claudin only, REPL-only inbox, no Windows, no Remote Control; mode parity holds messages across bypassPermissions
type: project
scope: sessions/peers, tools/SendMessage, tools/ListAgents
impact: structural
paths:
  - "src/sessions/peers/**"
  - "src/tools/SendMessageTool/**"
  - "src/tools/ListAgentsTool/**"
---

**Decision:** SendMessage is on by default (it had been swarm-only while the
Agent prompt already told the model to use it). It reaches background agents,
`"main"` (from a background agent) and other interactive Claudin sessions on
this machine, found through ListAgents. Sessions talk over a 0600 Unix socket
advertised with a token in the PID record; a send only ever dials a socket a
live session advertises. Unset `crossSessionInbound` means mode parity: a
message across the bypassPermissions line waits for the receiving user.

**Why:** the user runs parallel worktrees (`claudin-goal`, `claudin-loop`) in
separate terminals and wanted one session to ask another to run something and
say when it is idle — Claude Code 2.1.281 parity, measured from its binary
(`docs/features/cross-session-messaging.md` has the protocol).

**What changes for a teammate:**
- `ListAgents` and `SendMessage` are deferred; keep them so, the prefix budget
  is what the prompts-v2 work fought for. Receiver guidance rides the message.
- Text another agent wrote must never expand `@`-mentions: any new delivery
  path passes `skipInputDirectives` (see `isAgentAuthored`).
- The auto-mode classifier labels agent-written text on one line; a new origin
  kind that carries agent text belongs in `isAgentAuthored`.
- `scripts/migrations/probes/crossSessionMessaging.json` breaks every guard;
  re-run it after touching `src/sessions/peers/`.

**Rejected:**
- Interop with `claude` sessions: its socket protocol is undocumented and moves
  per release (2.1.281 added key files and a stable-address flag).
- Remote Control / cloud targets: need claude.ai auth and route through
  Anthropic; the `bridge:` scheme is refused with a reason.
- A headless inbox: `-p` closes stdin at start and nothing wakes `run()` after
  a turn; benches would also flood ListAgents.
- Windows named pipes in v1: no file mode, no Windows CI to test them.

**Evidence:** real-socket tests on both ends; tmux E2E on 2026-09-24 — a
message delivered as a new turn, a held one shown in the dialog and denied, a
pure subscription answered at once by an idle session, and a message +
subscription answered after the turn ended.
