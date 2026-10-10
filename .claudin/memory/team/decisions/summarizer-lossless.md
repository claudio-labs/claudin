---
name: summarizer-lossless
description: Since 2026-10-10 no tool result is cut — Grep/Glob are regrouped without losing a byte (toolResultCompaction.ts), and a result past its tool's persistence line is paged (first lines + a pointer, the rest read by offset), replacing the 2 KB preview; the summarizer's 7 cut strategies, source= reversibility, 2 build features and skipsResultSummarizer are deleted
type: project
scope: tool-results/compaction
impact: functional
paths:
  - "src/agent/tools/toolResultStorage.ts"
  - "src/agent/tools/toolResultCompaction.ts"
  - "src/agent/tools/toolResultCompaction/grep.ts"
  - "src/agent/tools/toolResultCompaction/glob.ts"
  - "src/tools/shellToolResultMappers.ts"
---

**Decision (user, 2026-10-10, branch `perf/summarizer-lossless`, stacked on #282):** compact, never cut. Past the line, page.

**The pipeline.** `processPreMappedToolResultBlock` runs `maybeCompactToolResult`, then `maybePersistLargeToolResult`. Nothing else touches a result.

**Compaction.** `src/agent/tools/toolResultCompaction*`, renamed from `toolResultSummarizer*` in a pure `git mv` commit.
- It applies to Grep and Glob output from 3,000 chars up. Everything else ships as it came.
- `compactGrepOutput` keeps rg's order and puts each run of one file under `--- path ---`. `--` and every other line stay as rg printed them.
  - A file gets a header only if it has a match line of its own, so a misread path never names a fake file.
  - A run gets a header only when the header pays for itself.
  - It bails on any line that would read as a header or a numbered line.
- `compactGlobOutput` puts adjacent paths under their `dir/`, keeping the order.
- Both are byte-reversible. The envelope is `<tool-result-compacted tool= strategy=>`, with no sizes.
- Off switches, names unchanged because they live in users' settings: `CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER` and the `toolResultSummarizerEnabled` config.

**Paging.** `buildLargeToolResultMessage(saved, text, maxChars)` produces a single message.
- Contents, in order:
  - `<persisted-output>`;
  - the size and the file path;
  - `Lines 1-K are below; Read the file from line K+1 for the rest.`;
  - lines 1–K exactly, as many as fit under the tool's line.
- The pointer comes first, so a relief stub that keeps the head keeps the pointer too.
- Lines per tool are unchanged: Grep 20k, Bash/Git 30k, the rest 50k.
- Storage's spill and Bash's own >30k spill both page. Bash pages from the untrimmed stdout, so the line numbers match the file.
- Text-block arrays are saved as joined `.txt`, not JSON, so `Read` offsets address lines.

**Deleted.**
- The summarizer's cut strategies: Bash head-tail-errors, the Grep cut, Glob top-50, WebFetch, Agent/MCP head-tail, json-structural and code-outline.
- `jsonArrayCompress.ts`, `makeReversibleIfElided` / `source=`, and the build features `TOOL_RESULT_JSON_COMPRESSION` and `TOOL_RESULT_CODE_OUTLINE`.
- `Tool.skipsResultSummarizer`, `UNSUMMARIZED_AGENT_TYPES` and `CLAUDIN_TOOL_RESULT_LOSSLESS`.
- The benches `grep-summarizer-replay`, `json-salient-probe` and `code-outline-ab`.
- `collapseIdenticalRuns` and `collapseDigitTemplates` moved to `outputFilter/Bash/collapse.ts`, since the Bash filter is their only user.

**Rejected on the way (two audit agents, 10-10).**
- Folding into `line (×N)`, and JSON minify: ambiguous, and they broke an Edit `old_string`. Neither fired once in the corpus.
- Re-sorting Grep by match count, and `… same as` back-references: both lost order.
- A header on every run: misread paths produced fake file names in 303 corpus results.
- Keeping the cut past the line, and the 2 KB preview: the model re-fetched after 33–100% of previews.

**Measured (free).** `former-cuts-replay.ts`, 14 days, 520 real cuts replayed through the live pipeline.
- 459 regrouped, 56 whole, 5 paged (1 Grep, 4 WebFetch). 0 cut. 0 broken pages: page plus file gives back the original every time.
- Chars +19% on those results: Glob −46%, Grep +15.5%, WebFetch +170% (paged at its 50k line). Median +0.9k chars per session.
- Audit round-trip over 4,103 transcripts: 0 lost, 0 reordered, 0 fake headers.

**Errors too (10-10, same branch).** `formatError` (toolErrors.ts) no longer keeps 5k + 5k: a tool's error text ships whole under its line and is paged past it (`pageErrorText`, toolResultStorage.ts), the file named by a hash of the text so a retry of the same failure writes nothing new. A failing shell run that spilled (`saveSpilledRun` → `pageFailedShellRun`, shellToolResultMappers.ts) is paged from its saved file before it throws, sized to the exact prefix `formatError` adds (`shellErrorPrefix`, toolErrors.ts), so the last lines of a failing suite — its summary — are always in the file. Probes: `errorPaging.json`. E2E 22 (failing run under the line, whole) and 23 (120k failing run, paged, summary in the file).

**Third audit round (10-10, three agents) — fixed on the branch.**
- A save that fails no longer ships the result whole: `toolResultFiles.ts` tries the session dir, then `$TMPDIR/claudin-tool-results/<session>`; saved nowhere, `pageUnsaved` still pages it under the line and says the rest was not kept.
- Past 64 MB (`MAX_SAVED_OUTPUT_BYTES`) the page says "only its first N is saved", never "Full output saved".
- The pointer gives the line count ("Lines 1-K of N"), so the end of a failing run is one Read away; a line longer than the page is fetched by byte (`tail -c +B`), the unit Bash counts in.
- A saved file's page has `MIN_PAGE_CHARS` (4k) of room: a PowerShell error with huge stderr no longer gives a 0-char page.
- A result shipped whole from `SAVE_WHOLE_FROM_CHARS` (6k) is saved too, and the relief clip stub names the copy (`savedCopyOf`, `; the full result is saved at …`), so a clipped result is read back instead of re-run — the gap the deleted `source=` used to fill.
- Spill I/O moved beside storage (`adoptOutputFile`, `pageSavedFile`); `SHELL_ERROR_PREFIX_ROOM` is gone.

**What still bounds a result.** Each tool's own limits are unchanged and out of scope: Grep `head_limit` 250 + offset, Glob 100 + offset, WebFetch 100k → model summary, MCP 25k tokens → its own spill. Old results are bounded by relief/microcompact. The Bash filter's one cut (#282) is a separate decision.

**Re-audit fixes (three agents, 10-10).**
- A shell run that spilled is paged from its **saved file's own head** (`readSavedHead`), not from stdout. The output filter, the blank-line strip and the 30k byte cap all reshape stdout, and a page cut from it claimed lines the model never saw. Its budget leaves room for the notes after it, so storage's old "already paged" guard is gone.
- A head's cut-short last line is never counted as shown (`pageForModel(…, complete=false)`). Pages never end on half a surrogate pair.
- The pointer gives a call that works at any file size: `Read the file with offset=K+1 and limit=K`. Offset alone is refused past 256 KB. A first line longer than the page points to Bash, since Read cannot split a line, and the budget sizes both pointer forms.
- The saved file's name carries a hash of its content, so a repeated tool_use_id (XML providers across a resume, MCP timestamp ids) never pages against another result's file.
- Glob redirect folds `| head -N` up to 100, the paths one Glob call returns; it stopped at 50 for the old cut.
- **Live check** (Sonnet 5.5, `bin/claudin -p` from a throwaway cwd, ~$0.70): 4 of 4 runs whose answer lay past the page recovered it by searching the saved file, with no re-run. The target was Bash row 5500 behind a page of 741 lines, and a Grep line at 2298 behind a page of 562.

**Not covered, separate decisions:**
- `toolErrors.formatError` keeps 5k + 5k of a failing command's output, with no saved file.
- The Bash floor's one cut (#282), WebFetch's 100k + model summary, MCP image truncation and relief clips.

**Evidence.**
- `toolResultCompaction.test.ts`: in-order decoders, 11 real rg fixtures and the line boundary.
- `toolResultStorage.test.ts`: page + file = original.
- `shellToolResultMappers.test.ts`: the Bash offset.
- Break-probe: `toolResultCompaction.json` and `paging.json`, every probe red.
- `read-credit-e2e.ts` scenarios 19 (compaction) and 20 (paging) on the bundle.
