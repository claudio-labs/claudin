---
name: summarizer-lossless
description: Since 2026-10-10 a tool result ships whole while it fits under its tool's persistence line — Grep/Glob regrouped without losing a line, the rest as it came — and is cut only past it (CLAUDIN_TOOL_RESULT_LOSSLESS=0 brings the cuts back); 4,103 transcripts round-trip byte-exact, replay +12.5% chars, Glob −46%
type: project
scope: tool-results/summarizer
impact: functional
paths:
  - "src/agent/tools/toolResultStorage.ts"
  - "src/agent/tools/toolResultSummarizer.ts"
  - "src/agent/tools/toolResultSummarizer/grep.ts"
  - "src/agent/tools/toolResultSummarizer/glob.ts"
---

**Decision (user, 2026-10-10, branch `perf/summarizer-lossless`, stacked on #282):** whole under the line, cut past it.
- `keepWholeUnderLine` (toolResultStorage.ts) runs `maybeCompactToolResult`. If the result fits under the persistence line, measured by persistence's own `contentSize`, it ships; only otherwise does `maybeSummarizeToolResult` (the cut, unchanged) run. Lines: Grep 20k, Bash 30k, others 50k.
- Only two regroups exist, and each puts every byte back.
  - `compactGrepOutput`: rg's order; each run of one file's lines under `--- path ---` (`NN:text` a match, `NN-text` context); `--` and every other line stay as rg printed them. A file earns a header only with a match line of its own, so a misread path (`phase-0-plan.md` taken as file `phase`, line 0) never names a fake file. A run earns one only when the header pays for itself. It bails if a line printed raw would read as a header or as a numbered line.
  - `compactGlobOutput`: adjacent paths under their `dir/`, order kept. It bails on a path that starts with a space.
- Bash, WebFetch, Agent and MCP results ship as they came while they fit.
- `<tool-result-compacted tool= strategy=>` carries no `original`/`kept`. It is not `isSummarizedContent`, so nothing is persisted for it, and it is idempotent.

**Rejected in the first draft (two audit agents, 10-10):**
- Folding repeated lines into `line (×N)`, and minifying JSON. Neither fired once over 4,103 transcripts. The fold was ambiguous with real ` (×N)` lines, and minifying broke an Edit `old_string` copied from a `cat x.json`.
- Re-sorting Grep files by match count, moving unparsed lines to the end, and `… same as` back-references. All three lost order or misattributed lines.
- A `persistAboveChars = Infinity` parameter on the summarizer. Any caller that forgot it never cut. The rule now lives in storage.
- A header for every attributed run (second draft). Misread paths got headers naming files that do not exist: 303 corpus results, 24 of them count listings.

**Why:** the user asked for no cuts, only lossless compaction. Two free censuses priced it.
- `summarizer-lossless-replay.ts`, 14 days, 517 replayed cuts:
  - 456 regrouped, 56 whole, 5 still cut;
  - chars +12.5%: Grep +15.5%, Bash +53%, WebFetch +55%, Glob −46%;
  - per session: median +0.9k chars.
- Audit round-trip over all 4,103 transcripts, decoded in order:
  - Grep 1,297 + 1,078 and Glob 125 + 62 results came back exact, with 0 reordered and 0 lost;
  - 0 headers name a file without a match;
  - the only loss left is the cut past the line: 11 Grep and 9 WebFetch results.
- `cut-refetch-census.ts`, 09-26..10-10: Grep summaries were re-fetched less often than uncut Grep >3k (11/18% against 19/24%). Bash summaries were re-fetched at 32–67% (already gone on reads since #282). Persisted 2 KB previews at 33–100%: that preview is the fallback this avoids.

**Evidence:** `toolResultSummarizer.lossless.test.ts` decodes every regroup back in order, byte for byte, pins the line at exactly the threshold, and covers misread paths and runs that do not pay. Storage-path cut tests (`integration`, `toolResultCodeOutline`, the storage hook test) set `=0`. Break-probe `losslessSummarizer.json` has 18 probes, all red. `read-credit-e2e.ts` scenarios 19-20 run on the bundle.
