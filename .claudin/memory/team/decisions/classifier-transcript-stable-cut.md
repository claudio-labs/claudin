---
name: classifier-transcript-stable-cut
description: Since 2026-10-24 the auto-mode classifier's transcript is cut at 25k-char chunk boundaries counted from the first entry and gets the whole 200k budget, so a long session stops rewriting its classifier cache every call (−72% writes per call in the replay, −59% classifier spend live on Sonnet 5.5); killswitch CLAUDIN_CLASSIFIER_STABLE_CUT=0
type: project
scope: src/permissions/yoloClassifier/transcript.ts, src/permissions/yoloClassifier/classify.ts
impact: functional
paths:
  - "src/permissions/yoloClassifier/**"
---

**Decision:** `serializeTranscriptForClassifier` serializes every entry, oldest
first, and cuts at chunk boundaries counted from the first entry: a boundary
follows the entry that brings a chunk to `CLASSIFIER_TRANSCRIPT_CHUNK_CHARS`
(25k), and an entry that large on its own opens a chunk of its own. The
transcript starts at the first boundary whose suffix fits, and
`classifierTranscriptBudget` gives it the whole `MAX_CLASSIFIER_TRANSCRIPT_CHARS`
(the action no longer comes out of it). When not even the newest chunk fits,
that call falls back to the newest-first fill. `CLAUDIN_CLASSIFIER_STABLE_CUT=0`
restores the old fill and the old budget, byte for byte.

**Why:** the classifier was ~24% of all spend in the 10-23..24 census, 90% of it
cache writes at the 1h price. The newest-first fill dropped the oldest kept entry
on every call past the 200k budget, so everything after the CLAUDE.md block was
written again: 15.7k per call in the long session 4c2d912b against 1.2k in a
short one, $30 of classifier there, 62% of that session's main thread. A stable
cut keeps the kept blocks byte-identical on an append and moves once per chunk.

**What changes for a teammate:** anything that shapes the classifier transcript
must keep its front still on an append — a per-call change near the start (a
counter, a timestamp, a reordering, a sliding window) brings the full rewrite
back. Re-run `classifier-cache-replay.ts` against recorded sessions before
changing the cut, the chunk size or what an entry serializes to. The window
past the budget is a sawtooth between ~150k and 200k chars, so the classifier
sees slightly less history on average than the old fill, and the oldest user
prompt leaves at a chunk move, unmarked.

**Rejected:**
- Merging each frozen chunk into one block: the growing tail block is never
  reused, about twice the cost.
- A breakpoint at the last chunk boundary: ~6% more saving for the 4th
  `cache_control`, which the request already uses.
- A classifier model per sub-agent: Explore's calls write ~0.2k each, ~$1-2 over
  two days.
- Approving `S=<literal>; … $S` and `cd <root>` locally: ~22 of 595 classifier
  Bash calls.
- Not done yet, open: pinning the first user prompt at the head (cache-safe, but
  it changes what the classifier sees); building the replay's action from the
  backfilled input the app sends.

**Evidence:**
- Replay, `scripts/bench/tokens/classifier-cache-replay.ts --since=2026-10-20`
  (run 10-24, after the chunk-sized-entry fix; the corpus grows, so re-runs
  drift): writes per call 15.3k → 4.3k (−72%) in the 4 threads past the budget,
  0 of 348 requests differ ≤150k, min kept 162.6k against a 150k floor,
  serialize ≤4.1 ms. Its tool stub is identity, which makes the stable arm look
  worse, not better.
- Live, Sonnet 5.5 (`scripts/bench/results/classifier-stable-cut-live-2026-10-24.md`):
  four 46-turn auto-mode sessions, 2 per arm, each past the budget for 12 calls.
  Classifier writes 1.13M → 0.34M per session (−70%), classifier spend $5.13 →
  $2.10 (−59%), main thread unchanged, rejects 12 vs 14 — every one the
  classifier declining to assess (~14% of calls in both arms), a separate finding.
- Break-probes: `classifierStableCut.json` 11 red plus a control;
  `classifierTranscript.json` pins the old fill, 8 red.
- The review round found the chunk-sized-entry case (one turn of six parallel
  ~30k calls left 12k kept); fixed before the PR.
