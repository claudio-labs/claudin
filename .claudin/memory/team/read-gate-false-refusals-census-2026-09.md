---
name: read-gate-false-refusals-census-2026-09
description: 2026-09-04 census of "Read it first" gate refusals (65 in 23 sessions) — the three false causes fixed in PR #157, what stayed out of scope, and the headless seeding gap that is still open
type: project
---

Census of read-before-edit gate refusals over 69 sessions (2026-08-17 → 2026-09-04),
paired tool_use↔tool_result: **65 real refusals in 23 sessions** — apply_patch 42/626
calls (6.7%), Edit 22/459 (4.8%), Write 1/187. 63/65 recovered; 45 in 2 round-trips,
7 refused twice. The outline→refusal loop the module header fears did NOT occur (0).

Fixed in PR #157 (`fix/read-gate-false-refusals`, 2026-09-04):
1. Edit `old_string` starting mid-line — `seenRegionCovers` sentinels refused text the
   model held (6 cases). Now `seenRegionCoversText` for Edit; hunks unchanged.
2. Injected CLAUDE.md/rule/MEMORY.md seeded `isPartialView` (8 cases, 7 MEMORY.md) — now
   `FileState.injectedView` + `satisfiesLineScopedReadGate` for Edit/apply_patch Update;
   Write/NotebookEdit/Delete keep the strict gate.
3. `/resume` restored only whole-file Reads (2 cases) — now ranges, `symbol=`, apply_patch,
   with `seenRanges` accumulation; outline results are no longer cached as file content.

**Why:** each false refusal cost a round-trip, on MEMORY.md a ~25 KB `view='full'`.

**How to apply:**
- Still open: **headless `-p` never seeds memory files into readFileState** at all
  (`runHeadlessStreaming.ts` only calls `extractReadFilesFromMessages`), so an Edit of
  CLAUDE.md there is `never-read` regardless of PR #157. TUI seeding is REPL.tsx +
  `attachments/memory.ts`.
- Out of scope, legitimately: 17 verified coverage-unseen apply_patch refusals; the
  "gate gaming" pattern (re-Reads with `limit ≤ 10`, one `offset=56 limit=1`) still
  exists, now aimed at the hunk.
- Replay scripts lived in `/tmp/readgate-census/` (census.ts, replay-new.ts) — a corpus
  replay of the coverage predicates is ~40 lines; rebuild rather than hunt for them.
- Related rule: `.claudin/rules/cache.md` "four-tool invariant" bullet carries the
  `injectedView` exception; see [[outline-mask-desync-zero-symbols]] for the earlier
  gate-adjacent audit.
