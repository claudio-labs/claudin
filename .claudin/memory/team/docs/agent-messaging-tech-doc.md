---
name: agent-messaging-tech-doc
description: docs/tech/agent-messaging/README.md is the design doc for agents asking each other (SendMessage await_reply, siblings, custom agents) and the source for the public site's docs/agents page
type: reference
paths:
  - "src/tools/SendMessageTool/**"
  - "src/tools/ListAgentsTool/**"
---

`docs/tech/agent-messaging/README.md` holds: who can message whom (main,
background/inline agents, siblings, other sessions), `await_reply` and every way
a wait ends, the `awaiting-reply` envelope, custom agents via `tools:`, name
rules, resume behaviour (readOnly kept, one resume per agent, killed agents),
the guards (50 agent sends, 10 session sends, plan-mode hold, sanitizing), known
limits, and the test/probe map.

Its last section, "Site page", is the outline for
https://www.claudiolabs.ai/docs/agents — the site lives outside this repo
([[claudiolabs-docs-site]]), so that page is updated separately. The transport
itself stays documented in `docs/features/cross-session-messaging.md`
([[cross-session-messaging]]).
