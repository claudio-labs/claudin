---
name: Token-efficiency feature roadmap (ranked verdicts)
description: The 2026-06-27 token-saving roadmap — BUILD #1–#7 shipped by 06-29, its tool-result compression half deleted 10-10 (compacted, never cut); what survives is the /usage tokens-saved line, verbosity steering and the loop→memory trigger, plus the full reason behind each SKIP
type: project
---

Ranked by a 7-agent research pass on 2026-06-27, each verdict grounded in this codebase. As a
roadmap it is superseded by [[roadmap-2026-07]], which condenses the SKIPs; this file keeps their
full reasons. The 2026-06 write-up of each BUILD item (benches, review rounds, SHAs) is in this
file's git history.

**How to apply:** if asked to build a SKIP item, surface the recorded reason first.

## What the BUILD list left on main (checked 2026-11-08)

- **Deleted 2026-10-10**, when tool results became compacted, never cut ([[summarizer-lossless]]):
  #1 JSON/array compression (`jsonArrayCompress.ts`; benched cost −13% on a 30-turn Sonnet run), #2's
  reversible `source=` backing, the `scanSymbols` code-outline variant (PR #95, `detectCodeLang.ts`),
  and the SmartCrusher batch built on #1 (#6 salient rows, PR #94; #7 constant-field hoist, PR #93).
  Every follow-up that tuned them is moot.
- **#3 tokens-saved line in `/usage`** (PR #90): `src/agent/context/tokensSaved.ts`, session-live.
  Open: project-aggregate persistence.
- **#4 verbosity steering** (PR #91): `VERBOSITY_STEERING_SECTION` in `src/agent/prompts/prompts.ts`,
  a dynamic section after the cache boundary, default on, `CLAUDIN_VERBOSITY_STEERING=0`. One run
  showed 26.4% fewer prose chars with answers intact, an earlier one ~2%; a runs=3 median is owed.
- **#5 repeated-error loop → memory extraction** (PR #92): `src/memory/extract/loopDetector.ts` — the
  same tool + key-sorted input erroring ≥3× in one human turn, unless its latest call succeeded, user
  cancel/deny excluded. A hit bypasses the extraction interval and steers to a `feedback` memory.
  `LOOP_ERROR_MEMORY_TRIGGER` flag, `CLAUDIN_LOOP_MEMORY_TRIGGER=0`. Extraction runs only interactive
  unless `CLAUDIN_EXTRACT_MEMORIES_HEADLESS` (`isExtractModeActive`, `src/memory/memdir/paths.ts`), so
  live-verify it in a tmux PTY, not `-p`. The 2026-06 `passport_quail`/`slate_thimble`/`bramble_lintel`
  gating is gone.

## SKIP — the recorded reasons (2026-06-27/29)

- **Code compression with tree-sitter** (L/XL): no tree-sitter dep; WASM + grammars fight the
  single-file bundle. `scanSymbols.ts` (regex) is the outline path.
- **ML prose compression (Kompress-style)** (XL): an ONNX model in the bundle — what the repo rejects.
- **Effort routing** (lower reasoning on mechanical turns): per-turn effort was dynamic only on the
  Anthropic path; `openaiShim` bound `reasoningEffort` at construction. Misclassifying an error or
  failed-test turn would dumb down the analysis.
- **Semantic/vector memory (HNSW):** scale is tiny (~51 files then; vectors pay off at 10k+ docs),
  native deps are bundle-stubbed, embeddings need phone-home. The premise "LLM-ranked recall already
  exists" changed: `findRelevantMemories.ts` was deleted 2026-09-21 and `paths:` loads memories on
  demand at zero model cost ([[team-memory-git-is-the-sync]]).
- **Cross-agent memory** (share with Codex/Gemini): scope creep — the `team/` dir covers the real case.
- **Relevance context fitting (BM25 + embeddings):** a per-turn relevance reorder breaks the clip
  frontier and invalidates the prefix. Only niche: BM25 selection inside `/compact` (M), low payoff.
- **Image compression:** exists — `sharp` + `src/terminal/image/imageResizer.ts` (dimension cap + JPEG
  quality ladder). An ML version (SigLIP) is XL for a cold path.
- **Live dashboard with confidence intervals** (XL): without measured ground truth the CIs are
  fabricated precision. The `/usage` line (#3) is the right form.
- **SmartCrusher (`../headroom`) features** — crushability tree, field-role detection, pattern
  classifier, lossless-first compaction renderer: all assumed `jsonArrayCompress.ts`, deleted 10-10.
  The reason that outlives it: the summarizer call site has no query or context (pure and stateless,
  must stay ink-free under `bun test`), so relevance/BM25/embedding anchors need a separate
  query-plumbing initiative plus a model dependency.

**Cross-cutting:** any marker, stub or injection must sit behind the clip frontier
(`.claudin/rules/cache.md` §1).
