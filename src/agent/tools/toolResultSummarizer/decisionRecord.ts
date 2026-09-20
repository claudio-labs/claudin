import type { StrategyName, SummaryDecision } from 'src/agent/tools/toolResultSummarizer/types.js'

// Strategy enum numeric IDs. id 5 ('read-head-tail') was retired; do not reuse
// — the numbering is quoted in benches and in the tests below.
export const STRATEGY_ID: Record<StrategyName, number> = {
  'head-tail-errors': 1,
  'grep-grouped': 2,
  'webfetch-stripped': 3,
  'webfetch-head-tail': 4,
  'glob-top-n': 6,
  'agent-head-tail': 7,
  'mcp-head-tail': 8,
  'json-structural': 9,
  'code-outline': 10,
}

let lastDecision: SummaryDecision | null = null

export function recordDecision(decision: SummaryDecision): void {
  lastDecision = decision
}

export function getLastSummaryDecision(): SummaryDecision | null {
  return lastDecision
}

/** Drop the record so one test cannot read the previous test's decision. */
export function resetLastSummaryDecision(): void {
  lastDecision = null
}
