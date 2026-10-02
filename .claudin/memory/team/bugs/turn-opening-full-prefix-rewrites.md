---
name: turn-opening-full-prefix-rewrites
description: FIXED 2026-10-01 (#273, then test/cache-prefix-guards) — turn-opening full rewrites are server thinking drops (prefix_binding_mismatch) after a client byte change; Skill attachment, SendMessage backfill and worktree/add-dir/cd section clears fixed; slash commands found clean; guards in cache.md §1
type: project
paths:
  - src/providers/cache/promptCacheBreakDetection.ts
  - src/agent/query.ts
---

**Symptom (planning, 09-14..28):** the first request of a new human turn re-bills the whole
prefix (`server: messages changed`) while the detector says `prompt unchanged`; 48 cases, ~$100;
32.6% after turns of ≥100 calls; the prompt shrinks. Claude Code transcripts show none.

**Mechanism (verified 2026-10-01):** every such break carries
`message.input_transformations[{type:"thinking_dropped", reason:"prefix_binding_mismatch"}]`
(recorded in claudin's transcripts, read by nothing): 59 drop events 09-14..10-01, 58 broke the
cache. Opus 5.5's preserved thinking binds each block to the exact bytes of system + tools +
messages before it (count_tokens probe: cache_control, effort, display, betas and
context_management do NOT enter the binding). A byte change behind a block makes the server
drop it and, cascading, every later block — so the prompt shrinks and everything after the
change is rewritten; the read falls to the system floor when the change is >20 positions back.
count_tokens is a free oracle: `input_tokens < context_management.original_input_tokens` = drops.

**Main source (live repro 2/2, with the wire diff):** a Skill invoked mid-turn whose
processPromptSlashCommand emits turn-start attachments (task_reconcile, auto_mode). In-turn,
`query.ts` normalizes each tool-yielded message ALONE (`normalizeMessagesForAPI([update.message])`
then `.filter(user)`), so the attachment becomes a plain text block after the skill body. The
REPL array keeps it as an `attachment`, so from the next turn `reorderAttachmentsForAPI` bubbles
it into the "Launching skill" tool_result. 9 turn-open breaks 09-14..10-01 (~3.9M rewritten,
~$37), about half of the long-turn ones — /pre-pr runs at the end of long turns. Skill without an
attachment: 0/11. Repro: `scratchpad` scripts were throwaway — headless stream-json, two user
turns, `CLAUDIN_ENABLE_TASKS=1`, TaskCreate + TaskUpdate in_progress, then the Skill.

**Detector blindness:** `streaming.ts` calls `paramsFromContext` twice per request (the
`[Claude] thinking=` debug block, then the real request); each runs `recordRenderedMessages`,
so the second compares the request with itself and erases the mutation. No live
`messages mutated at` line exists in any transcript.

**The rest, 2026-10-01 (branch `test/cache-prefix-guards`):**
- SendMessage: `query.ts` yielded a clone with the fields `backfillObservableInput` adds, and
  every consumer stored it, so the next turn re-sent the tool_use with type/recipient/content.
  Fixed: only the SDK output builds that view (`withObservableToolInputs`).
- F4: EnterWorktree, ExitWorktree, /add-dir (and permission-prompt directory grants) and /cd
  cleared the memoized system prompt sections. Fixed: the section stays, `env_delta` announces
  the change at the tail.
- Slash command between turns and plan mode: the wire e2e found no break in either (headless).
- Not a cause: the billing header's fingerprint moves between a session's first request and the
  next, but the API does not cache that block (measured).

**Status:** main source fixed in #273. Render once:
`query.ts` keeps tool-yielded messages unrendered (`src/agent/query/toolResultMessages.ts`), so
the turn and the next one render the same array; `streaming.ts` renders each request once and a
retry keeps the detector's verdict; the `[Cache:]` line names new thinking drops
(`server dropped N thinking blocks from messages.K`). Live probe
`scripts/bench/ab/skill-attachment-cache-probe.ts` (Opus 5.5, 2026-10-01): claudin 1.1.39
rewrote 3/3 (3 thinking blocks dropped from messages.9), the branch 0/3 (read back the previous
prompt − 2 tokens). Guards for every path (loop, REPL, transcript, attachments, tools, system
prompt, the built CLI's wire, strict mode): `.claudin/rules/cache.md` §1. A new drop the label
names after these is a new cause. [[token-census-2026-09-28]].
