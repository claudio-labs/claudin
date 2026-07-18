---
name: collapseRuns + blank-strip is SAFE since the 2026-06-27 root fix
description: bash-output-filter — the old collapseRuns + /^\s*$/ footgun (stray ` (×N)` defeating onEmpty) was fixed at the root in collapseIdenticalRuns; the combo is now allowed
type: feedback
---

`FilterSpec` MAY set `collapseRuns: true` alongside a blank-line regex (`/^\s*$/`) in `stripLinesMatching`. The footgun that previously forbade this was fixed at the root.

**Why (history + current state):** `collapseIdenticalRuns` (stage 4 in `pipeline.ts`) used to turn a run of ≥2 blank lines into the literal ` (×N)` line (`collapseIdenticalRuns(['',''])` → `[' (×2)']`), which the later blank-strip (stage 7) couldn't match — leaving a cosmetic artifact AND defeating the `onEmpty` sentinel. **Root fix (2026-06-27, this branch):** `collapseIdenticalRuns` now collapses a blank/whitespace run to a single blank with NO count marker (the `(×N)` marker is only emitted when `count > 1 && line.trim() !== ''`). So a blank run → one blank line → blank-strip removes it → `onEmpty` fires correctly. The earlier per-filter workarounds (`mixCompile`/`basedpyright` dropped collapseRuns; `turbo`/`nx`/`uv`/`poetry` avoided it) were reverted/retired since the combo is now safe.

**How to apply:** combining `collapseRuns` + blank-strip is fine. Do NOT reintroduce the `(×N)`-on-blank-lines behavior in `collapseIdenticalRuns` — the `line.trim() !== ''` guard on the marker is load-bearing. A regression test in `toolResultSummarizer.test.ts` + the per-filter blank-run integration tests (cc/dotnet/swift/php/elixir/linters) assert a ≥2 blank run never emits a count marker and the sentinel still fires; break-and-restore verified.
