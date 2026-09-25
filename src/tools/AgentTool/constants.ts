export const AGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars per run).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
  'WebResearcher',
  'WebResearcherManager',
])
// Built-in agents whose report is payload all the way through: Explore quotes
// the lines a caller edits from, and the summarizer's head/tail cut (8k chars
// and 100 lines) drops the ones in the middle. AgentTool.skipsResultSummarizer
// exempts them; the persistence threshold still spills an oversized report.
export const UNSUMMARIZED_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
])
