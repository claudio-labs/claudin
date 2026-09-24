---
name: opus-5-5-default-effort-medium
description: 2026-09-24 default flip — Opus 5.5 on first-party Anthropic defaults to medium effort (was high), the default Claude Code ships; the only lever that brought claudin's session cost to Claude Code's
type: project
scope: providers/effort
impact: functional
paths:
  - src/providers/effort/effort.ts
---

**Decision:** `getDefaultEffortForModel` (`src/providers/effort/effort.ts`) returns `medium` for
Opus 5.5 on the first-party provider, ahead of the flagship branch whose `includes('opus-5')`
also matches `opus-5-5`. Opus 4.8, Opus 5 and Fable 5.x keep `high`; Opus 5.5 on Bedrock, Vertex
or Foundry is untouched. Taken by the user on 2026-09-24, committed on `perf/prompts-v2`.

**Why:** Claude Code 2.1.280's model catalog carries `default_effort: "medium"` for Opus 5.5
(`docs/tech/anthropic-betas/wire-matrix.md`). In the proxy-recorded session A/Bs
([[session-cost-round-3-2026-09-23]]) medium was the only arm that closed the cost gap: $1.32
and $1.20 against Claude Code's $1.22 and $1.27 in the same runs, 18/18 hidden tests in every
session. At high, claudin thought roughly twice as much as Claude Code. The v2 prompt
([[prompts-v2-2026-09]]) shrank the prefix but did not move the thinking.

**What changes for a teammate:** an Opus 5.5 session with no effort pin now thinks less and
verifies less — in the A/B, 16 reads instead of 25 and 2–3 test runs instead of 4–5 — and gets
more read-gate refusals, which `*** Resubmit` absorbs. A pin still wins over the default:
`settings.effortLevel`, a project pin (`/effort high`), `CLAUDIN_EFFORT_LEVEL` or `--effort`.
`/effort auto` in a project means this model default. Anyone who pinned `high` sees no change.

**Rejected:** keeping `high` for Opus 5.5 — it held the ~2× thinking gap in every run; the
prompt-side levers (display, anti-narration, tools, the v2 prompt) did not close it.

**Evidence:** runs `20260923-201138` (A) and `20260923-210735` (C); wire check on the built
bundle with an empty config dir and a mock profile: Opus 5.5 → `output_config.effort:"medium"`,
Opus 5 and Fable 5.1 → `"high"`, `CLAUDIN_EFFORT_LEVEL=high` → `"high"`. Pinned by
`effort.xhighDefault.test.ts`, `opus55.test.ts` and `scripts/migrations/probes/opus55EffortDefault.json`.
