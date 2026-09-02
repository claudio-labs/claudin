---
name: Headless -p does not drain auto-background agents
description: In claudin `-p` print mode, auto-background sub-agents are orphaned, not awaited — breaks token benchmarks vs claude inline
type: project
---

In claudin headless `-p`, an orchestrator that spawns auto-background sub-agents (autoBackgroundAgentsEnabled default ON) **non-deterministically** drains them: sometimes the parent waits and surfaces the agent reports (sentinel present, `out~1.2k`), sometimes it exits BEFORE the sub-agents finish (orphaned: `out=21`, ~5 turns, sentinel absent). When orphaned, the sub-agent token usage is NOT in the parent's final `usage`, so the run looks artificially cheap.

**Why:** observed both outcomes across runs of the SAME command in `scripts/profile/agent-bg-token-bench.ts` (2 agents x 10 files). The script prints a `drained` (Y/N) column = whether the BENCH_AGENT_REPORT sentinel appeared.

**How to apply:** For any token/cost bench, ONLY trust runs where `drained=Y`; discard `N` runs (work was skipped). For a fully deterministic apples-to-apples vs Claude Code (inline), run claudin with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Always do N>=3 reps and take the median — single runs are noisy. Measured (drained, n=1): claudindev bg-ON used ~55% fewer tokens and ~40% less est. cost than claudin stable inline on this workload, because the parent does not re-absorb sub-agent work into its own context.
