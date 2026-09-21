---
name: attachment-producers-leak-parent-state
description: Six producers in allThreadAttachments read state the parent owns; the three-way classification now lives as a comment above the array in pipeline.ts, and isTeammateOwnLoop is the discriminator a bare agentId gate cannot replace
type: project
---

`getAttachments` (`src/agent/attachments/pipeline.ts`) runs for sub-agents too,
and for a child it **only ever runs mid-tool-loop** — `query.ts` calls it with
`input === null` after each batch of tool results, so whatever it emits is
merged into the same user turn as the `tool_result` before it. `runAgent` builds
the child's opening turn itself (`initialMessages`), so a child never reaches
this pipeline with a real input.

That is why a leak here reads as **injected page content**: two `WebResearcher`
agents reported the parent's `plan_mode` / `auto_mode` reminders as a
prompt-injection attempt in the page they had just fetched (#224, 2026-09-20).

## What shipped

- **#226** (commit `9a5a04f9`, 2026-09-20) — the four mode producers
  (`plan_mode`, `plan_mode_exit`, `auto_mode`, `auto_mode_exit`) became
  main-thread only, with the exit gates **ahead of** the one-shot flag read. A
  child gets its plan-mode brief from `src/tools/AgentTool/subagentPlanMode.ts`
  in its opening turn instead, worded from its own tool list.
- **#227** (2026-09-21, uncommitted on `main` at session end) — four more, plus
  the compaction-path emitter #226 missed:
  - `date_change` — read *and cleared* the process-global `lastEmittedDate`, so
    a child crossing midnight emitted the notice into its own throwaway context
    and the parent was never told.
  - TodoV2 `todo_reminders` — handed a child the session task list plus *"Keep
    this list current as you work"*. This is the **default interactive path**
    (`isTodoV2Enabled()` is `!getIsNonInteractiveSession()`) and `TaskUpdate`
    survives `filterToolsForAgent` for a *sync* child, so the child could mutate
    the shared list.
  - `companion_intro` — REPL-only wording ("sits beside the user's input box",
    "respond in ONE line or less") stapled to a child's tool_result.
  - `teammate_mailbox` — resolved to the **lead's** identity for a child and
    called `markMessagesAsReadByPredicate`, destroying the lead's DMs.
  - `createPlanModeAttachmentIfNeeded` (`src/agent/compact/postCompactAttachments.ts`)
    — a *second* plan-mode emitter outside the pipeline; it now delegates to
    `buildSubagentPlanModeAttachment` so a compacting child does not get a brief
    contradicting the one it opened with.

## The classification lives in the source, not here

A three-way table sits above `allThreadAttachments` in `pipeline.ts`: per-child /
session-owned / global-but-load-bearing. Read it before adding a producer. The
two traps it records:

- **DO NOT gate `claude_md_delta`, `memory_index`, `git_status_delta`.** They
  read process-global context and look exactly like the bugs above, but
  `filterStaticDedupKeys` (`src/providers/transport/api.ts`) strips `claudeMd`
  and `gitStatus` from `prependUserContext` on *every* request, sub-agents
  included — so for a child that sets no omit flag these attachments are the
  only delivery path there is.
- **Two are safe only by accident**: `ultrathink_effort` takes `input` (always
  null for a child) and `team_context` bails on `hasAssistantMessage` (a child's
  mid-loop messages always have one).

## `agentId` is not the gate for session-owned state

An **in-process teammate** reaches `runAgent` like any sub-agent and therefore
has an `agentId` (`inProcessRunner.ts` calls `runAgent` inside
`runWithTeammateContext`; its override sets no `agentId`), yet it legitimately
owns the mailbox — its own loop is the only mid-turn mail path,
`waitForNextPromptOrShutdown` delivers only between turns — and
`getTaskListId()` deliberately resolves to the leader's team list for it.
`AsyncLocalStorage` propagates into whatever that loop spawns, so the agent name
and task list id are **identical on both sides**: identity cannot separate them.

`ownsSessionScopedState()` in `src/agent/attachments/threadOwnership.ts` is the
predicate; `isTeammateOwnLoop` on `ToolUseContext` is the discriminator.

**How to make a context field NOT inherit:** assign it post-hoc in `runAgent`
(beside `preserveToolUseResults`), **never** through `SubagentContextOverrides`.
`createSubagentContext` builds its return object explicitly — fields it does not
list are dropped, but override fields *are* copied into every nested fork
(that is how `omitClaudeMdAttachments` reaches them, see
[[cache-ttl-tiering-subagents]] which predicted this whole bug class).

## Stale comment, corrected

`src/agent/attachments/changedFile.ts:4-10` says `services.ts` "under `bun test`
fails to load". **That is no longer true** — `subagentSharedGates.test.ts`
imports `getTeammateMailboxAttachments` from it and passes. A six-line throwaway
test settles an untestability claim in under a minute; don't design around one
on faith. `pipeline.ts` itself remains untested.
