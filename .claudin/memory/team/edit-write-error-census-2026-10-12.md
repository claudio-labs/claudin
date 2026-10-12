---
name: edit-write-error-census-2026-10-12
description: Edit/Write error census 2026-10-05..12 — Edit 22/557 (3.9%, was 6.6%), Write 9/389 (2.3%, was 4.5%); 19 of 22 Edit errors are the read gate, 14 resubmitted byte-identical; two harness bugs found and NOT fixed (trailing-newline coverage refusal, sub-agent resume with an empty readFileState)
type: project
---

Paired tool_use↔tool_result over every transcript since 2026-10-05, deduped by
tool_use id, `-tmp*` bench projects split out (`census.ts`, `rootcause.ts`,
`followup.ts` in that session's scratchpad, ~60 lines each — rebuild rather
than hunt). Bench-only: 27 memory-guard refusals in memory-write-ab (every
run's first decision write lacked `scope:`/`impact:`; real traffic 1/11) and 2
sensitive-file denials in extract-memories-ab.

**Real traffic.** Edit 22/557: never-read 11, partial-view 8 (all served
regions, so every one was an exact unique match), not-found 2, multi-match 1
(3 of those 3 are model errors, 2 from glm-5.3-flash). Write 9/389: never-read
4, partial 2, memory guard 1, classifier 2. Reaction requests ≈ $5/wk —
contexts were 300–650k cache-read, so each extra round-trip costs $0.15–0.35.

**Bug 1 — trailing newline (unfixed).** `seenRegionCoversText`
(`src/tools/shared/readBeforeEditMessages.ts`) compares `trimLines(old_string)`
against segments joined WITHOUT their last `\n` (`sliceLines`). An old_string
ending in `\n` whose last line is the last line read is "not seen", and the
served region cannot fix it — the identical resubmit is refused again.
Reproduced: state offset 460 `'l460\nl461\n  });\n});\n'`, needle
`'  });\n});\n'` → false; without the `\n` → true. 3 this week (floor.test.ts
×2, collapseReadSearch.test.ts), ~9 since 09-12. Fix: drop one trailing `\n`
from the needle.

**Bug 2 — sub-agent resume (unfixed).** `resumeAgent.ts` passes
`forkContextMessages: undefined`, so `runAgent.ts` builds an EMPTY
`readFileState`; `resumedMessages` are never replayed into it (REPL's /resume
does: `extractReadFilesFromMessages(…, READ_FILE_STATE_CACHE_SIZE)`). Every
file read before the stop is "never read" after it. 11 of 78 sub-agents were
resumed this week, mostly after a 529
([[builtin-subagents-skip-529-retry]]); 2 refusals (PreviewBox.tsx Write,
sandbox.md Edit).

**Smaller:** the 100-entry LRU evicted a file the agent had written itself
(boot.sh, 107 paths later), then the bare Write refusal sent it to
`Read(limit:3)`, refused again as partial, and it abandoned the rewrite; only 4
transcripts passed 100 paths. Write's never-read refusal serves no content, so
it costs Read + Write. 4 of 10 genuine never-read Edits were files printed by
Bash (`cat` chains, `sed -n A,Bp`) — the credit is off and does not cover
`sed -n` anyway.

**Open policy question (user's call):** Patch applies a never-read file when
every hunk matches exactly and dropped partial-view on 09-24
([[apply-patch-any-read]]); Edit still refuses both. All 19 Edit gate refusals
were exact unique matches and 14 came back identical — aligning Edit would take
it to ~0.5%.

**How to apply:** after fixing the two bugs, re-run the census a week later
and expect partial-view refusals with a trailing-`\n` old_string at 0 and no
"not been read yet" on a file read before a resume.
