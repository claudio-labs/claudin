---
name: cut-results-request-cost-2026-09-25
description: Audit 2026-09-25 of whether cut tool results (Bash filter cap, tool-result summarizer, Grep/Glob pagination, persisted output, Read head-tail) cost extra requests via re-runs/re-reads — ~0.3% of requests; the Grep summarizer costs none; the one leak is the cap on model-bounded reads (sed -n / head -N) in sub-agents
type: project
---

Question: is the request count partly the model re-running a Bash or
re-reading a file because the filter cap or the summarizer cut its result?
Answer: barely. Measured over every session-cache A/B transcript (09-23..25,
~450 claudin sessions, 7,728 requests, plus the Claude Code arm as control) and
the real corpus 09-14..25 (17.2k main + 16.7k sub-agent requests). Method: a
"pure recovery" request = within 3 requests of a cut, no edit in between, and
every tool call in it re-runs the cut command or re-reads only files that
command already targeted; compared against the same rate after UNCUT results
of the same tool and size. Committed in #252 as
`scripts/bench/tokens/cut-refetch-census.ts` (run it with the test preload).

- **Grep summarizer (grep-grouped, 1,059 cuts) and Grep/Glob pagination:
  no excess** — 16–22% pure-recovery vs 21–25% after uncut Grep >3k.
- **Bash cap:** ~48 extra requests in 11 days. All of it is
  `bounded-read` in sub-agents: the model sized the read itself
  (`sed -n 'A,Bp;C,Dp'`, `cat f | head -80`, awk NR ranges), got 61–150 lines,
  the 15+15 cut removed the middle it asked for, and 30% of the time the next
  request Read the same file (baseline 15%). `callerBudgets` only covers
  GitTool; nothing in `floor.ts` recognizes a model-bounded read.
- **Read head-tail / char truncation:** ~25 extra (≈50% vs 7–15%).
- **Persisted output:** one Read of the saved file each time, by design (~35).
- **Bench:** ~0.1 request per session; latest run `-153340` pathcap arm 0.0,
  claudindev 0.1, placebo 0.3 — against a 3.3-request gap to Claude Code.
  The `nocap` arm (`-135901`) had MORE requests (21.0 vs 16.4/19.6), so
  removing cuts does not lower the count. Caps cost the bench tokens, not
  requests: 41% of caps are followed by a Read batch that re-reads the capped
  file alongside new ones, and README.md is re-Read mostly for the read gate
  (`cat` is not a Read), see [[request-count-levers-2026-09-24]].

**How to apply:** don't chase request count through the summarizer. If the
cap is touched again, the lever is exempting model-bounded reads from it —
done in #252, see [[cap-keeps-model-bounded-reads]].
