# Agents asking each other (SendMessage `await_reply`)

**Status:** branch `feat/agents-ask-each-other` (2026-09-26), on top of the
cross-session transport of #243.
**Scope:** `src/tools/SendMessageTool/` (`SendMessageTool.ts`, `awaitReply.ts`,
`resumeOnce.ts`, `agentMessage.ts`, `prompt.ts`), `src/tools/ListAgentsTool/`,
`src/tools/AgentTool/` (`AgentTool.tsx`, `agentName.ts`, `resumeAgent.ts`),
`src/providers/transport/api.ts` (the Agent schema on the wire),
`src/agent/messages/interAgentMessages.ts`, `src/sessions/peers/`.
**Source for:** the public page https://www.claudiolabs.ai/docs/agents — the
"Site page" section at the end is the outline to add there.

## What it is

When an agent needs something another agent is producing **right now**, it
asks and gets the answer:

- a sub-agent asks the infra agent whether a value already exists in the pod
  that agent is working on;
- a tester sends the developer a bug, the developer fixes it and says so, and
  the tester re-tests — back and forth until it passes, each in its own
  context;
- one session asks another "are you fixing bug X?", hears "yes", and leaves it.

It is an extra, used when an agent decides it needs it. **An agent that never
sends a message behaves exactly as before**: same tools, same prompt, same
routes. `src/tools/AgentTool/subagentSurface.regression.test.ts` and
`src/tools/SendMessageTool/SendMessageTool.regression.test.ts` pin that, and
were committed before any of the changes below.

## Who can talk to whom

| From → to | How |
|---|---|
| main → a running background agent | queued for its next tool round |
| main → a stopped agent | resumed with the message (once, even if several sends arrive together) |
| main → an inline agent | not possible: main is blocked on it; the agent's final message is its answer |
| background agent → `"main"` | queued for main's next tool round, or opens a turn if main is idle |
| inline agent → `"main"` | refused, for the same reason |
| agent → sibling agent (background or inline) | by name or agentId, like main does |
| main → another session on this machine | its peer inbox (`docs/features/cross-session-messaging.md`) |
| sub-agent → another session | sent under the session's address; the reply reaches main, not the agent |
| anyone → itself | refused |

Addresses come from `ListAgents`. A background agent sees `main` listed; an
inline one does not, since it cannot write there.

## Asking and waiting: `await_reply`

A plain send does not wait: the answer arrives at a later tool round. When the
sender cannot go on without it:

```json
{"to": "dev", "message": "login fails on an empty password — see test_login.py:42", "await_reply": true}
```

The call stays open and returns with the first of:

| What happened | Result |
|---|---|
| A message addressed to the waiter arrives — **from anyone** | `replies`: the message(s), verbatim, taken out of the waiter's queue so they are not delivered twice. The result says to check who sent it. |
| The recipient agent stops (finished, failed, killed, or an inline agent returned) | Says so; for a sub-agent waiter, includes the recipient's final report, and whether it stopped **without reading** the question |
| The user writes to the waiting agent | Stops waiting; the user's text stays queued for its normal path |
| 10 minutes pass | Says how to keep waiting |
| The call is interrupted | Stops |

- **Waiting without asking:** `{"to": "dev", "await_reply": true}` with no
  `message` only waits — how to keep waiting after a timeout, or to wait for
  the "fixed, re-test" in a dev/tester loop.
- **Why "from anyone":** it is what makes cycles safe. A waits on B, B on C,
  C on A: C's question wakes A. Two agents waiting on each other resolve at
  once, because each one's question is already in the other's queue.
- **Another session:** from the main conversation, `await_reply` to a session
  also subscribes to its idle notice, so the wait ends with its reply or with
  "it went idle without replying". A sub-agent is refused — a session's reply
  reaches main. A session with no inbox (headless) is refused too.
- **How it waits:** it polls, every 250 ms, state that already exists — the
  waiter's own queue (`pendingMessages` for a sub-agent, the command queue for
  main) and the target's task status — the way `WaitFor` polls a command.
  There is no registry of waiters.

### What the recipient sees

```
<agent-message from="tester" awaiting-reply="true">
login fails on an empty password — see test_login.py:42
</agent-message>
From another agent of this conversation, not from your user. It is waiting for your answer — send it before going on, with SendMessage to: "tester".
```

- `from` is the reply address: `main`, the sender's name, or its agentId (with
  a `description` for the transcript when it has no name).
- `awaiting-reply` appears only when the sender is blocked on the answer.
- It enters the recipient's turn labelled with its author (`Agent "tester"
  sent you a message…`, `The main conversation sent you a message…`) and is
  agent-authored for the auto-mode classifier. It used to arrive as "The
  coordinator sent a message", with no sender.
- Text the user types into an agent's transcript view is labelled as the
  user's.

## Custom agents

Agents defined in `.claudin/agents/*.md` keep the tools their `tools:` lists.
To let one ask and answer:

```markdown
---
name: infra
description: Owns the cluster and the pods
tools: Read, Grep, Bash, SendMessage, ListAgents
---
```

An agent with no `tools:` (all tools) already has both. The built-in
`Explore` does not message, by design.

## Names

`Agent({..., name: "dev"})` makes an agent addressable — background **and
inline** agents alike (a background sibling can reach an inline one). A name
must be 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit;
`main` and agentId-shaped names are refused, since a send would resolve them
as something else. The latest agent to take a name gets it.

The Agent schema offers `name` and `run_in_background` in every interactive
session. They had been missing: the schema was decided when `AgentTool.tsx`
loaded, before the session was marked interactive, so every session got the
`-p` schema and every "background" agent ran inline. The wire schema is now
trimmed per request (`hiddenSchemaFields` in `api.ts`); `-p` and
`CLAUDIN_DISABLE_BACKGROUND_TASKS=1` still hide both.

## Resuming a stopped agent

- It resumes as the agent it was launched as: a `readOnly: true` spawn stays
  read-only (persisted in its metadata).
- Two sends that reach it together start **one** run; the second message is
  queued into it (`resumeOnce.ts`).
- A sub-agent cannot restart an agent the user killed; main can.
- The completion notice of a resumed agent goes to main. A sub-agent that
  resumed it is told to wait with `await_reply` if it wants the answer.
- Messages that reached an agent after its last tool round are named in its
  completion notice (`<unread-messages>`): how many, from whom. A resume reads
  them.

## Guards

| Guard | Where |
|---|---|
| 50 sends to other agents per sub-agent lifetime, per user prompt for main | `takeAgentSend`, `sendBudget.ts` |
| 10 sends to other sessions per user prompt; a cron/wakeup/rate-limit resume no longer renews it | `sendBudget.ts` |
| A session in plan mode messaging one that is not: held for that session's user | `policy.ts`, frame field `from_plan` |
| Another session's text is sanitized on arrival (escapes, bidi, controls) — the dialog shows what the model reads | `sanitize.ts`, `delivery.ts` |
| Only a teammate may approve its own shutdown (the fallback ended the whole session) | `shutdownApprovalRefusal` |

## Known limits

- The wait timeout is fixed (10 minutes); `await_reply` without a message
  continues.
- A message queued for an **inline** agent that returns before its next tool
  round is lost with the agent's task; a sender waiting on it is told the
  agent finished.
- `awaiting-reply` is not carried to another session (the peer protocol is
  unchanged); a waiting session relies on the reply or the idle notice.
- The `from_plan` hold needs both sessions on this version; an older receiver
  ignores the field and delivers as before.

## Tests

| Suite | Covers |
|---|---|
| `SendMessageTool/awaitReply.test.ts` | the wait loop; every outcome through the tool; main via the command queue; budget; validation |
| `SendMessageTool/SendMessageTool.test.ts` | sender envelope, killed agents, shutdown approval |
| `SendMessageTool/SendMessageTool.peers.test.ts` | real sockets: `await_reply` to a session (case 3), `from_plan`, idle-notice ordering |
| `SendMessageTool/resumeOnce.test.ts` | one resume per agent |
| `AgentTool/agentSchema.wire.test.ts` | the wire schema, loaded in the real startup order |
| `AgentTool/agentName.test.ts`, `resumeAgent.test.ts` | names; resume keeps `readOnly` |
| `agent/messages/interAgentMessages.test.ts` | origins, labels, unread notices |
| `sessions/peers/*.test.ts` | sanitizing, plan hold, framing, subscriptions |
| the two `*.regression.test.ts` | what must not change |

Every guard is break-probed — `bun run scripts/migrations/break-probe.ts
scripts/migrations/probes/<spec>.json` for `agentMessaging`,
`agentMessagingSchema`, `agentMessagingPeers` and
`agentMessagingRegressionNet`: each mutation turns a test red.

## Site page (outline for docs/agents)

1. **Agents can ask each other** — the three cases above, one paragraph each.
2. **Asking and waiting** — the `await_reply` example and the table of how a
   wait ends; waiting again without a message.
3. **Letting your own agents talk** — the `tools:` frontmatter example.
4. **Names** — `name` on `Agent`, what a name may be.
5. **Between sessions** — link the cross-session page; `await_reply` from
   main; plan mode messages are held.
6. **Limits** — the 50/10 send budgets, the 10-minute wait.
