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

// The select example names tools that are deferred: Read, Edit and Grep never
// are, so an example loading them taught a call that loads nothing.
const UNTIL_FETCHED =
  ' Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked.'
const UNTIL_FETCHED_WITH_FORMS =
  ' Until fetched, only the name is known, and the tool cannot be invoked — except one listed with a call form ("— call directly: X({…})"), whose whole input is that line: call it directly, no fetch needed.'
const PROMPT_TAIL = ` This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Query forms:
- "select:WebFetch,WebSearch" — fetch these exact tools by name
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
 * `CLAUDIN_DEFERRED_CALL_FORMS=1`: a built-in deferred tool with a `callForm`
 * is listed with it, and the ToolSearch prompt and the listing's header say a
 * listed form is called directly. Off until the A/B decides; read per call so
 * a test can set it.
 *
 * In 10-25..30, 25 of 2,281 main requests were a ToolSearch alone, and every
 * session of the 10-30 A/B opened with `select:EnterPlanMode,ExitPlanMode`.
 * The API takes a tool_use for a deferred tool that was never loaded, and
 * the input is validated here, so a tool whose whole input fits on the line
 * needs no load: TaskUpdate called from the plan approval's text validated
 * 5 of 5 times on Opus 5.5.
 */
function isDeferredCallFormsEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_DEFERRED_CALL_FORMS)
}

/** What separates a deferred tool's name from its call form in the listing. */
const CALL_FORM_SEPARATOR = ' — call directly: '

/**
 * Format one deferred-tool line for the listing (the deferred_tools_delta
 * attachment, or the legacy <available-deferred-tools> message). Search hints
 * (tool.searchHint) are not rendered — the hints A/B (exp_xenhnnmn0smrx4,
 * stopped Mar 21) showed no benefit. MCP tools never get a call form: their
 * input comes from a server, not from this repository.
 */
export function formatDeferredToolLine(tool: Tool): string {
  if (isDeferredCallFormsEnabled() && tool.callForm && tool.isMcp !== true) {
    return `${tool.name}${CALL_FORM_SEPARATOR}${tool.callForm}`
  }
  return tool.name
}

const DEFERRED_HEADER =
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:'
const DEFERRED_HEADER_WITH_FORMS =
  'The following deferred tools are now available. One listed with a call form is called directly with that input, no ToolSearch needed. The others\' schemas are NOT loaded: use ToolSearch with query "select:<name>[,<name>...]" to load them before calling them:'

/**
 * The header of a deferred-tool listing, chosen from the listed lines alone:
 * the delta attachment persists its lines and is re-rendered on every
 * request, so a transcript written without call forms keeps its bytes, and
 * with them its cached prefix, whatever the flag says when it resumes.
 */
export function deferredToolsHeader(lines: readonly string[]): string {
  return lines.some(line => line.includes(CALL_FORM_SEPARATOR)) ? DEFERRED_HEADER_WITH_FORMS : DEFERRED_HEADER
}

export function getPrompt(): string {
  return (
    PROMPT_HEAD +
    getToolLocationHint() +
    (isDeferredCallFormsEnabled() ? UNTIL_FETCHED_WITH_FORMS : UNTIL_FETCHED) +
    PROMPT_TAIL
  )
}
