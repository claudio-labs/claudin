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

**Measured (free).** `summarizer-lossless-replay.ts`, 14 days, 520 real cuts replayed through the live pipeline.
- 459 regrouped, 56 whole, 5 paged (1 Grep, 4 WebFetch). 0 cut. 0 broken pages: page plus file gives back the original every time.
- Chars +19% on those results: Glob −46%, Grep +15.5%, WebFetch +170% (paged at its 50k line). Median +0.9k chars per session.
- Audit round-trip over 4,103 transcripts: 0 lost, 0 reordered, 0 fake headers.

**What still bounds a result.** Each tool's own limits are unchanged and out of scope: Grep `head_limit` 250 + offset, Glob 100 + offset, WebFetch 100k → model summary, MCP 25k tokens → its own spill. Old results are bounded by relief/microcompact. The Bash filter's one cut (#282) is a separate decision.

**Evidence.**
- `toolResultCompaction.test.ts`: in-order decoders, 11 real rg fixtures and the line boundary.
- `toolResultStorage.test.ts`: page + file = original.
- `shellToolResultMappers.test.ts`: the Bash offset.
- Break-probe: `losslessSummarizer.json` and `paging.json`, every probe red.
- `read-credit-e2e.ts` scenarios 19 (compaction) and 20 (paging) on the bundle.
