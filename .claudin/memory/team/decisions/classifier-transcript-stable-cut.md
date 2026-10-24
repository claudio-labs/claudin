---
name: classifier-transcript-stable-cut
description: Since 2026-10-24 the auto-mode classifier's transcript is cut at 25k-char chunk boundaries counted from the first entry and gets the whole 200k budget, so a long session stops rewriting its classifier cache every call (−75% writes per call in the replay); killswitch CLAUDIN_CLASSIFIER_STABLE_CUT=0
type: project
scope: src/permissions/yoloClassifier/transcript.ts, src/permissions/yoloClassifier/classify.ts
impact: functional
paths:
  - "src/permissions/yoloClassifier/**"
---

**Decision:** `serializeTranscriptForClassifier` serializes every entry, oldest
first. It finds chunk boundaries counted from the first entry: a boundary
follows the entry that brings a chunk to `CLASSIFIER_TRANSCRIPT_CHUNK_CHARS`
(25k). The transcript starts at the first boundary whose suffix fits the
budget. `classifierTranscriptBudget` gives the transcript the whole
`MAX_CLASSIFIER_TRANSCRIPT_CHARS`, and the action no longer comes out of it.
When not even the newest chunk fits, that call falls back to the newest-first
fill. `CLAUDIN_CLASSIFIER_STABLE_CUT=0` restores the old fill and the old
budget, byte for byte.

**Why:** the classifier was ~24% of all spend in the 10-23..24 census, and 90%
of that was cache writes at the 1h price.
- The newest-first fill dropped the oldest kept entry on every call past the
  200k budget.
- With that entry gone, everything after the CLAUDE.md block shifted and was
  written again: 15.7k per call in the long session 4c2d912b, against 1.2k in
  a short one.
- Its classifier cost $30 there, 62% of the session's main thread.
- With a stable cut, appending keeps the kept blocks byte-identical, and the cut
  moves once per chunk of growth.

**Evidence:**
- `scripts/bench/tokens/classifier-cache-replay.ts --since=2026-10-20`. It runs
  the real serializer in both arms over a model of the prompt cache (one
  breakpoint, 20-block lookback, 1h TTL). The pre-registered gate passed:
  - writes per call 15.2k → 3.8k (−75%) in the 3 threads past the budget;
  - 0 of 348 requests differ in threads ≤150k;
  - min kept 162.6k;
  - serialize ≤3.2 ms.
  - Total ≈$51.7 → $18.2 over the window (transcript part only).
- Break-probe `classifierStableCut.json`: 10 red plus a control.
  `classifierTranscript.json` pins the old fill: 8 red.
- Live, Sonnet 5.5 (`scripts/bench/results/classifier-stable-cut-live-2026-10-24.md`):
  four 46-turn auto-mode sessions, 2 per arm, each past the budget for 12 calls.
  - Classifier cache writes fell from 1.13M to 0.34M per session (−70%), and classifier
    spend from $5.13 to $2.10 (−59%).
  - The main thread was unchanged, and rejects were 12 against 14.
  - Every reject in both arms was the classifier declining to assess (~14% of calls).
    That is a separate finding.

**Rejected, measured in the 10-24 scratchpad replay (`sim2.ts`):**
- Merging each frozen chunk into one block: $18 against $9. The growing tail
  block is never reused.
- A breakpoint at the last chunk boundary: −6% more, and it takes the 4th
  `cache_control`.
- A classifier model per sub-agent: Explore's calls write ~0.2k each, ~$1-2 over
  two days.
- Approving `S=<literal>; … $S` and `cd <root>` locally: ~22 of 595 classifier
  Bash calls.

**What is left:** 24 full misses in the replay. They come from more than 20 new
blocks between two classifier calls, and from the cut moving once per 25k
chars. The "ideal" arm (only new content written) was $2.7.
