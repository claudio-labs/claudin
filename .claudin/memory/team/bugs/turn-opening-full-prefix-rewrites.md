---
name: turn-opening-full-prefix-rewrites
description: Main source FIXED 2026-10-01 (branch fix/skill-attachment-prefix-rewrite) — turn-opening full rewrites are server thinking drops (input_transformations prefix_binding_mismatch) after a client byte change; a Skill + turn-start attachment rendered differently in-turn vs next turn; slash-command and SendMessage cases still open
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

**Still unexplained:** turn-open drops after slash commands (`local_command`), and a few whose
first dropped block follows only tool results (SendMessage, Bash). Sibling F4: the system prompt
grows after EnterWorktree / plan mode and drops everything from messages.1.

**Status:** main source fixed on branch `fix/skill-attachment-prefix-rewrite` (PR). Render once:
`query.ts` keeps tool-yielded messages unrendered (`src/agent/query/toolResultMessages.ts`), so
the turn and the next one render the same array; `streaming.ts` renders each request once and a
retry keeps the detector's verdict; the `[Cache:]` line names new thinking drops
(`server dropped N thinking blocks from messages.K`). Live probe
`scripts/bench/ab/skill-attachment-cache-probe.ts` (Opus 5.5, 2026-10-01): claudin 1.1.39
rewrote 3/3 (3 thinking blocks dropped from messages.9), the branch 0/3 (read back the previous
prompt − 2 tokens). The slash-command and SendMessage cases above stay open; the drop label
should name them next time they happen. [[token-census-2026-09-28]].
