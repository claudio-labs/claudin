import { feature } from 'bun:bundle'
import { getDeferredDeltaLegacySession } from 'src/platform/bootstrap/state.js'
import type { Tool } from 'src/tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'
import { isCompactToolPromptsEnabled } from 'src/agent/prompts/toolPromptTier.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

export { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/constants.js'

import { TOOL_SEARCH_TOOL_NAME } from 'src/tools/ToolSearchTool/constants.js'

const PROMPT_HEAD = `Fetches full schema definitions for deferred tools so they can be called.

`

/**
 * Build, RunTests, Typecheck and WaitFor wait behind ToolSearch: ~11.5k chars
 * of schema that every request carried, for tools used in 30–45% of sessions.
 * When a Bash command has a better home in one of them, Bash's advice names it
 * and the ToolSearch call that loads it. `CLAUDIN_EAGER_DEV_TOOLS=1` sends them
 * eagerly again — the A/B arm and the escape hatch. Read per call and never per
 * project, like the Monitor rule: the tools array is a shared cache prefix.
 */
const DEFERRED_DEV_TOOLS: ReadonlySet<string> = new Set([
  BUILD_TOOL_NAME,
  RUN_TESTS_TOOL_NAME,
  TYPECHECK_TOOL_NAME,
  WAITFOR_TOOL_NAME,
])

/**
 * True → announce deferred tools via persisted delta attachments. False →
 * claude/streaming.ts prepends an ephemeral <available-deferred-tools> block at
 * messages[0] on every request, so any change to the deferred pool (an MCP
 * connect, a discovery) rewrites messages[0] and invalidates the whole cached
 * prefix. On by default in this fork since 2026-06-11; upstream shipped it
 * off. CLAUDIN_DEFERRED_TOOLS_DELTA=0 is the killswitch. It must not change
 * while the process lives: this hint and the announcement mechanism flip
 * together. toolSearch.ts re-exports it — it imports this module, so the
 * definition lives here.
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_DEFERRED_TOOLS_DELTA)
}

// Matches isDeferredToolsDeltaActive in toolSearch.ts (not imported —
// toolSearch.ts imports from this file; the legacy-session latch is read
// from bootstrap/state directly). When active: tools announced via
// system-reminder attachments. Otherwise: prepended
// <available-deferred-tools> block (pre-gate behavior, also kept for
// sessions latched to the legacy format by
// maybeLatchLegacyDeferredAnnouncement — the hint and the announcement
// mechanism MUST flip together or the tools array bytes diverge from the
// resumed session's warm cache).
function getToolLocationHint(): string {
  const deltaActive =
    isDeferredToolsDeltaEnabled() && !getDeferredDeltaLegacySession()
  return deltaActive
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

/**
 * Check if a tool should be deferred (requires ToolSearch to load).
 * A tool is deferred if:
 * - It's an MCP tool (always deferred - workflow-specific)
 * - It has shouldDefer: true
 *
 * A tool is NEVER deferred if it has alwaysLoad: true (MCP tools set this via
 * _meta['anthropic/alwaysLoad']). This check runs first, before any other rule.
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out via _meta['anthropic/alwaysLoad'] — tool appears in the
  // initial prompt with full schema. Checked first so MCP tools can opt out.
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred (workflow-specific)
  if (tool.isMcp === true) return true

  // Never defer ToolSearch itself — the model needs it to load everything else
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  // Fork-first experiment: Agent must be available turn 1, not behind ToolSearch.
  // Lazy require: static import of forkSubagent → coordinatorMode creates a cycle
  // through constants/tools.ts at module init.
  if (feature('FORK_SUBAGENT') && tool.name === AGENT_TOOL_NAME) {
    type ForkMod = typeof import('src/tools/AgentTool/forkSubagent.js')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('src/tools/AgentTool/forkSubagent.js') as ForkMod
    if (m.isForkSubagentEnabled()) return false
  }

  // The v2 tool descriptions move Monitor (in 2.6% of sessions) behind
  // ToolSearch too, like the four rarely used tools that are always deferred.
  if (tool.name === MONITOR_TOOL_NAME && isCompactToolPromptsEnabled()) return true

  if (DEFERRED_DEV_TOOLS.has(tool.name)) {
    return !isEnvTruthy(process.env.CLAUDIN_EAGER_DEV_TOOLS)
  }

  return tool.shouldDefer === true
}

/**
 * Format one deferred-tool line for the <available-deferred-tools> user
 * message. Search hints (tool.searchHint) are not rendered — the
 * hints A/B (exp_xenhnnmn0smrx4, stopped Mar 21) showed no benefit.
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
