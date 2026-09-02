---
name: cache-ab-bench harness has structural bugs
description: scripts/profile/cache-ab-bench.ts per-turn table is cumulative-replicated not delta, run-to-run variance is huge, and claude binary exits 1 in ~17s under the harness even after stdin fix
type: project
---

`scripts/profile/cache-ab-bench.ts` produces output that looks per-turn but isn't, and is too noisy for single-run comparisons. Discovered 2026-06-08 while validating `feat/cache-head-anchor`.

**Why:** Three independent failure modes converge:
1. `extractTimeline` parses `usage` events cumulatively but emits the same totals on every output row, so the printed "per-turn" table shows blocks of byte-identical rows (e.g. 11× `cR=26.8k cW=0`, then 11× `cR=26.8k cW=8.8k`, etc.) — these are NOT per-turn deltas, they're the running total of a single request snapshotted N times. The TOTALS line is real.
2. Run-to-run variance on the same binary + same flags + same cwd is enormous: claudin r:w observed at 0.73, 1.06, 2.57, 3.39, 3.68 across consecutive runs. Likely driven by non-determinism in tool-call ordering / whitespace between runs causing cache hit-or-miss in the warmup turns. Single-run A/Bs are noise > signal.
3. `claude` binary exits 1 in ~17s when invoked through `spawnSync` in the bench harness, even after fixing `stdio: ['ignore', ...]` (the original bug was a 3s stdin wait). Manual `claude -p "$PROMPT" --model claude-sonnet-4-6 --output-format stream-json --verbose --allowedTools Read` with the SAME prompt completes successfully in ~130s with 32 real turns and $1.12 cost — so the binary works, the harness mis-spawns it. Root cause not yet identified.

**How to apply:**
- DO NOT cite head-to-head numbers from this script (claudin vs claude) until the claude exit-1 is fixed — when claude exits early, the script still prints TOTALS that look plausible but they reflect a single failed initial response replayed across rows.
- DO NOT cite per-turn behaviour from the printed table — fix `extractTimeline` to emit deltas before reading anything into per-turn patterns.
- For one-sided claudin-only validation, run N≥3 and use the median; a single run can swing r:w by ~5×.
- The `30 mixed-size files` fixture (added in `8f91a7fb`) is fine; the harness is what needs work.
- Pre-existing context: the script was the basis for `defer-cache-marker-shipped.md`'s r:w 0.97→10.48 claim. That earlier claim was on a SMALL 13-turn fixture where the script's flaws happened to cancel out; don't assume the script is generally trustworthy because it was directionally right once.
