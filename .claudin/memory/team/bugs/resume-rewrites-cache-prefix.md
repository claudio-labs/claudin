---
name: resume-rewrites-cache-prefix
description: FIXED 2026-09-23 — --resume re-sent a different prefix (dropped attachments, parallel tool results reordered on a timestamp tie), so claudin re-wrote the whole history into the cache (40% read-back vs Claude Code's 100%); now 100%
type: project
paths:
  - "src/sessions/pure/logging.ts"
  - "src/sessions/pure/attachmentPersistence.ts"
  - "src/sessions/resume/chain.ts"
---

**Symptom.** The first request after a resume reads back only the tools +
system prefix (~27.7k tokens) and writes everything after it again. Measured
by `scripts/bench/ab/session-cache-ab.ts` on 2026-09-23 (Opus 5.5, N=3):
claudindev read back 40.4% [40.1–43.1%] of the prefix it had cached and wrote
38.0k tokens on the resume turn ($0.30, 16% of the session, 45% of the gap to
Claude Code); Claude Code 2.1.280 read back 100% and wrote 1.3k. The cost grows
with the context at resume time.

**Root cause.** `isLoggableMessage` (`src/sessions/pure/logging.ts`) keeps only
`deferred_tools_delta` (and opt-in `hook_additional_context`) out of all
attachments for non-ant users, so on resume:
- `messages[0]` loses `agent_listing_delta`, `git_status_delta`,
  `skill_listing` and `bash_git_instructions` (~9.3k chars). The delta
  producers then re-announce them in the NEW user message instead.
- The "extra `\n`" on the persisted deferred-tools block is NOT a renderer
  bug: `joinTextAtSeam` (`src/agent/messages/normalize.ts`) appends `\n` to
  whatever text block sits before a merged user message. Live, that was the
  git-instructions block; with it gone the seam moves onto the deferred block.
  Restore the neighbours and the bytes come back — do not touch the seam.
- Reminders folded into tool results mid-session (e.g. a path-scoped rule's
  `nested_memory` on a Read of a `.ts` file) are gone, a second divergence.
- The resume latches for skills and git instructions already existed
  (`restoreSkillStateFromMessages` in `src/sessions/conversationRecovery.ts`,
  whose comment names exactly this cache break) but could never fire, because
  those types were never saved.

**Second root cause, found only by the session A/B.** With attachments
persisted, 2 of 3 resumed sessions still read back 41%/60%: a batch of
parallel Reads is written in completion order, often within one millisecond,
and `recoverOrphanedParallelToolResults` (`src/sessions/resume/chain.ts`)
sorted the recovered results by timestamp with the ties left in tool_use
order — so resume re-sent the batch reordered. Claude Code never hit it in the
bench because it batched its reads into one `cat` instead of parallel Reads.
The zero-cost probe cannot see it (one tool call); an offline diff of the
recorded transcripts found it in seconds — now committed as
`RESUME_DIFF_RUN=<run dir> bun test scripts/bench/ab/resume-transcript-diff.test.ts`
(renders the JSONL in write order vs through `loadConversationForResume`).

**Traps for the fix.** Persisting attachments is not enough on its own:
- `nested_memory` dedup lives per engine (`QueryEngine.loadedNestedMemoryPaths`,
  the REPL's `loadedNestedMemoryPathsRef`) and is not rebuilt from history, so a
  persisted rule gets injected twice unless the set is seeded on resume.
- A persisted trailing attachment makes `detectTurnInterruption` report an
  interrupted turn and append "Continue from where you left off."; Stop hooks
  add attachments after the final reply.
- Still not byte-stable after persisting: `plan_mode`, `file` (@-mention) and
  todo/task reminders render live state; `currentDate` changes across days;
  hook attachments recorded between a tool_use and its result sit off the
  main chain and are not recovered.

Claude Code 2.1.280 re-sends every message byte-identically (its only
difference is the billing-header system block, which the API does not cache).

**Reproduce** with zero API calls: `bun scripts/bench/ab/resume-wire-probe.ts`
(and `--bin=claude` for the reference). It prints the first diverging byte per
message and the `messages[0]` block list before and after the resume.

**Status: FIXED 2026-09-23 on branch `fix/session-cache`** — an exhaustive
per-type persistence policy (`src/sessions/pure/attachmentPersistence.ts`),
hook attachments ignored by the interruption check, nested_memory seeded from
history, parallel results tie-broken by write order. Same A/B re-run: resume
read-back 40.4% → 100% in all three reps, resume-turn write 38.0k → 1.1k,
session cost −27%. The durable contract is `.claudin/rules/cache.md` §7;
guards: `resumePrefixDeterminism.test.ts`, `resume/chain.test.ts`, the probe,
the transcript diff. See [[session-cache-ab-bench-2026-09-23]].
