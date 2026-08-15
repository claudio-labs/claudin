// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from 'src/Tool.js'
// All tool modules are loaded lazily to avoid evaluating ~50 tool schemas,
// prompts, and dependency chains at module load time. This shaves significant
// time off startup (the tools aren't needed until the action handler runs,
// long after the REPL mounts). Node's require() caches the module after the
// first call, so each getter is effectively evaluated once.
/* eslint-disable @typescript-eslint/no-require-imports */
const getAgentTool = () =>
  require('src/tools/AgentTool/AgentTool.js').AgentTool as typeof import('src/tools/AgentTool/AgentTool.js').AgentTool
const getSkillTool = () =>
  require('src/tools/SkillTool/SkillTool.js').SkillTool as typeof import('src/tools/SkillTool/SkillTool.js').SkillTool
const getBashTool = () =>
  require('src/tools/BashTool/BashTool.js').BashTool as typeof import('src/tools/BashTool/BashTool.js').BashTool
const getFileEditTool = () =>
  require('src/tools/FileEditTool/FileEditTool.js').FileEditTool as typeof import('src/tools/FileEditTool/FileEditTool.js').FileEditTool
const getFileReadTool = () =>
  require('src/tools/FileReadTool/FileReadTool.js').FileReadTool as typeof import('src/tools/FileReadTool/FileReadTool.js').FileReadTool
const getFileWriteTool = () =>
  require('src/tools/FileWriteTool/FileWriteTool.js').FileWriteTool as typeof import('src/tools/FileWriteTool/FileWriteTool.js').FileWriteTool
const getApplyPatchTool = () =>
  require('src/tools/ApplyPatchTool/ApplyPatchTool.js').ApplyPatchTool as typeof import('src/tools/ApplyPatchTool/ApplyPatchTool.js').ApplyPatchTool
const getGlobTool = () =>
  require('src/tools/GlobTool/GlobTool.js').GlobTool as typeof import('src/tools/GlobTool/GlobTool.js').GlobTool
const getNotebookEditTool = () =>
  require('src/tools/NotebookEditTool/NotebookEditTool.js').NotebookEditTool as typeof import('src/tools/NotebookEditTool/NotebookEditTool.js').NotebookEditTool
const getWebFetchTool = () =>
  require('src/tools/WebFetchTool/WebFetchTool.js').WebFetchTool as typeof import('src/tools/WebFetchTool/WebFetchTool.js').WebFetchTool
const getTaskStopTool = () =>
  require('src/tools/TaskStopTool/TaskStopTool.js').TaskStopTool as typeof import('src/tools/TaskStopTool/TaskStopTool.js').TaskStopTool
const getBriefTool = () =>
  require('src/tools/BriefTool/BriefTool.js').BriefTool as typeof import('src/tools/BriefTool/BriefTool.js').BriefTool
const getLSPTool = () =>
  require('src/tools/LSPTool/LSPTool.js').LSPTool as typeof import('src/tools/LSPTool/LSPTool.js').LSPTool
const getRunTestsTool = () =>
  require('src/tools/RunTestsTool/RunTestsTool.js').RunTestsTool as typeof import('src/tools/RunTestsTool/RunTestsTool.js').RunTestsTool
const getTypecheckTool = () =>
  require('src/tools/TypecheckTool/TypecheckTool.js').TypecheckTool as typeof import('src/tools/TypecheckTool/TypecheckTool.js').TypecheckTool
const getBuildTool = () =>
  require('src/tools/BuildTool/BuildTool.js').BuildTool as typeof import('src/tools/BuildTool/BuildTool.js').BuildTool
const getGitTool = () =>
  require('src/tools/GitTool/GitTool.js').GitTool as typeof import('src/tools/GitTool/GitTool.js').GitTool
const getRenameTool = () =>
  require('src/tools/RenameTool/RenameTool.js').RenameTool as typeof import('src/tools/RenameTool/RenameTool.js').RenameTool
// Dead code elimination: conditional import for internal-only tools
const REPLTool = null
const SuggestBackgroundPRTool = null
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
const getCronTools = () => [
  require('src/tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
  require('src/tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
  require('src/tools/ScheduleCronTool/CronListTool.js').CronListTool,
  // One-shot in-session wakeup for /loop dynamic mode. Rides the session
  // cron delivery machinery, so it ships and gates alongside the cron tools
  // (isEnabled → isKairosCronEnabled).
  require('src/tools/ScheduleWakeupTool/ScheduleWakeupTool.js')
    .ScheduleWakeupTool,
]
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('src/tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
  : null
const MonitorTool = feature('MONITOR_TOOL')
  ? require('src/tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
const SendUserFileTool = feature('KAIROS')
  ? require('./tools/SendUserFileTool/SendUserFileTool.js').SendUserFileTool
  : null
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? require('./tools/PushNotificationTool/PushNotificationTool.js')
        .PushNotificationTool
    : null
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool
  : null
const getTaskOutputTool = () =>
  require('src/tools/TaskOutputTool/TaskOutputTool.js').TaskOutputTool as typeof import('src/tools/TaskOutputTool/TaskOutputTool.js').TaskOutputTool
const getWebSearchTool = () =>
  require('src/tools/WebSearchTool/WebSearchTool.js').WebSearchTool as typeof import('src/tools/WebSearchTool/WebSearchTool.js').WebSearchTool
const getTodoWriteTool = () =>
  require('src/tools/TodoWriteTool/TodoWriteTool.js').TodoWriteTool as typeof import('src/tools/TodoWriteTool/TodoWriteTool.js').TodoWriteTool
const getExitPlanModeV2Tool = () =>
  require('src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js').ExitPlanModeV2Tool as typeof import('src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js').ExitPlanModeV2Tool
const getTestingPermissionTool = () =>
  require('src/tools/testing/TestingPermissionTool.js').TestingPermissionTool as typeof import('src/tools/testing/TestingPermissionTool.js').TestingPermissionTool
const getGrepTool = () =>
  require('src/tools/GrepTool/GrepTool.js').GrepTool as typeof import('src/tools/GrepTool/GrepTool.js').GrepTool
// Lazy require to break circular dependency: tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
const getTeamCreateTool = () =>
  require('src/tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('src/tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('src/tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('src/tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('src/tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('src/tools/SendMessageTool/SendMessageTool.js').SendMessageTool
const getAskUserQuestionTool = () =>
  require('src/tools/AskUserQuestionTool/AskUserQuestionTool.js').AskUserQuestionTool as typeof import('src/tools/AskUserQuestionTool/AskUserQuestionTool.js').AskUserQuestionTool
const getReportFindingsTool = () =>
  require('src/tools/ReportFindingsTool/ReportFindingsTool.js').ReportFindingsTool as typeof import('src/tools/ReportFindingsTool/ReportFindingsTool.js').ReportFindingsTool
const getToolSearchTool = () =>
  require('src/tools/ToolSearchTool/ToolSearchTool.js').ToolSearchTool as typeof import('src/tools/ToolSearchTool/ToolSearchTool.js').ToolSearchTool
const getEnterPlanModeTool = () =>
  require('src/tools/EnterPlanModeTool/EnterPlanModeTool.js').EnterPlanModeTool as typeof import('src/tools/EnterPlanModeTool/EnterPlanModeTool.js').EnterPlanModeTool
const getEnterWorktreeTool = () =>
  require('src/tools/EnterWorktreeTool/EnterWorktreeTool.js').EnterWorktreeTool as typeof import('src/tools/EnterWorktreeTool/EnterWorktreeTool.js').EnterWorktreeTool
const getExitWorktreeTool = () =>
  require('src/tools/ExitWorktreeTool/ExitWorktreeTool.js').ExitWorktreeTool as typeof import('src/tools/ExitWorktreeTool/ExitWorktreeTool.js').ExitWorktreeTool
const getTaskCreateTool = () =>
  require('src/tools/TaskCreateTool/TaskCreateTool.js').TaskCreateTool as typeof import('src/tools/TaskCreateTool/TaskCreateTool.js').TaskCreateTool
const getTaskGetTool = () =>
  require('src/tools/TaskGetTool/TaskGetTool.js').TaskGetTool as typeof import('src/tools/TaskGetTool/TaskGetTool.js').TaskGetTool
const getTaskUpdateTool = () =>
  require('src/tools/TaskUpdateTool/TaskUpdateTool.js').TaskUpdateTool as typeof import('src/tools/TaskUpdateTool/TaskUpdateTool.js').TaskUpdateTool
const getTaskListTool = () =>
  require('src/tools/TaskListTool/TaskListTool.js').TaskListTool as typeof import('src/tools/TaskListTool/TaskListTool.js').TaskListTool
// Dead code elimination: conditional import for CLAUDE_CODE_VERIFY_PLAN
const VerifyPlanExecutionTool =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? require('src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        .VerifyPlanExecutionTool
    : null
const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
  ? require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE')
  ? require('./tools/CtxInspectTool/CtxInspectTool.js').CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? require('./tools/TerminalCaptureTool/TerminalCaptureTool.js')
      .TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('src/agent/coordinator/coordinatorMode.js') as typeof import('src/agent/coordinator/coordinatorMode.js'))
  : null
const SnipTool = feature('HISTORY_SNIP')
  ? require('./tools/SnipTool/SnipTool.js').SnipTool
  : null
const ListPeersTool = feature('UDS_INBOX')
  ? require('./tools/ListPeersTool/ListPeersTool.js').ListPeersTool
  : null
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? (() => {
      require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
      return require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
    })()
  : null
const agentWorkflowTools = feature('AGENT_WORKFLOWS')
  ? (
      require('src/tools/AgentWorkflow/tools.js') as typeof import('src/tools/AgentWorkflow/tools.js')
    ).getAgentWorkflowTools()
  : null
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('src/tools/PowerShellTool/PowerShellTool.js') as typeof import('src/tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */
import { feature } from 'bun:bundle'
import uniqBy from 'lodash-es/uniqBy.js'
import { isToolSearchEnabledOptimistic } from 'src/agent/tools/toolSearch.js'
import { isTodoV2Enabled } from 'src/agent/tasks/tasks.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getDenyRuleForTool } from 'src/permissions/permissions.js'
import { hasEmbeddedSearchTools } from 'src/agent/tools/embeddedTools.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { isPowerShellToolEnabled } from 'src/platform/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from 'src/vcs/git/worktreeModeEnabled.js'
import { onGlobalConfigChange } from 'src/platform/config/config.js'
import { onRuntimeStateChange } from 'src/platform/bootstrap/state.js'
import { onGrowthBookRefresh } from 'src/platform/analytics/growthbook.js'
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from 'src/tools/REPLTool/constants.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from 'src/constants/tools.js'
export { REPL_ONLY_TOOLS }

// Cache for isEnabled() results. Keyed by tool name; invalidated on every
// global config change or runtime state transition (LSP connect/disconnect,
// kairos/brief opt-in, allowed-channels update). Prevents redundant
// env/config/flag reads when getTools() is called multiple times within the
// same config state.
let _enabledCacheVer = 0
const _enabledCache = new Map<string, { ver: number; val: boolean }>()
onGlobalConfigChange(() => { _enabledCacheVer++ })
onRuntimeStateChange(() => { _enabledCacheVer++ })
onGrowthBookRefresh(() => { _enabledCacheVer++ })

function cachedIsEnabled(tool: { name: string; isEnabled(): boolean }): boolean {
  const cached = _enabledCache.get(tool.name)
  if (cached !== undefined && cached.ver === _enabledCacheVer) {
    return cached.val
  }
  const val = tool.isEnabled()
  _enabledCache.set(tool.name, { ver: _enabledCacheVer, val })
  return val
}

/**
 * Predefined tool presets that can be used with --tools flag
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  return tools.filter(tool => cachedIsEnabled(tool)).map(tool => tool.name)
}

/**
 * Get the complete exhaustive list of all tools that could be available
 * in the current environment (respecting process.env flags).
 * This is the source of truth for ALL tools.
 */
/**
 * NOTE: This MUST stay in sync with https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/claude_code_global_system_caching, in order to cache the system prompt across users.
 */
export function getAllBaseTools(): Tools {
  return [
    getAgentTool(),
    getTaskOutputTool(),
    getBashTool(),
    // Ant-native builds have bfs/ugrep embedded in the bun binary (same ARGV0
    // trick as ripgrep). When available, find/grep in Claude's shell are aliased
    // to these fast tools, so the dedicated Glob/Grep tools are unnecessary.
    ...(hasEmbeddedSearchTools() ? [] : [getGlobTool(), getGrepTool()]),
    getExitPlanModeV2Tool(),
    getFileReadTool(),
    getFileEditTool(),
    getFileWriteTool(),
    getApplyPatchTool(),
    getRenameTool(),
    getNotebookEditTool(),
    getWebFetchTool(),
    getTodoWriteTool(),
    getWebSearchTool(),
    getTaskStopTool(),
    getAskUserQuestionTool(),
    getReportFindingsTool(),
    getSkillTool(),
    getLSPTool(),
    getRunTestsTool(),
    getTypecheckTool(),
    // CLAUDIN_DISABLE_BUILD_TOOL=1 drops it entirely, for the same reason as
    // the Git tool below: the description is paid on every request, so the
    // killswitch has to remove the schema, not just the behaviour.
    ...(isEnvTruthy(process.env.CLAUDIN_DISABLE_BUILD_TOOL) ? [] : [getBuildTool()]),
    // CLAUDIN_DISABLE_GIT_TOOL=1 drops it entirely — the description is paid on
    // every request, so the killswitch has to remove the schema, not just the
    // behaviour. See src/tools/GitTool/GitTool.ts.
    ...(isEnvTruthy(process.env.CLAUDIN_DISABLE_GIT_TOOL) ? [] : [getGitTool()]),
    getEnterPlanModeTool(),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled()
      ? [getTaskCreateTool(), getTaskGetTool(), getTaskUpdateTool(), getTaskListTool()]
      : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isWorktreeModeEnabled() ? [getEnterWorktreeTool(), getExitWorktreeTool()] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled()
      ? [getTeamCreateTool(), getTeamDeleteTool()]
      : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(agentWorkflowTools ?? []),
    ...(SleepTool ? [SleepTool] : []),
    ...getCronTools(),
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    getBriefTool(),
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [getTestingPermissionTool()] : []),
    // MCP resource tools are added conditionally by fetchCapabilities.ts
    // when an MCP server supports resources — not via getAllBaseTools().
    // Include ToolSearchTool when tool search might be enabled (optimistic check)
    // The actual decision to defer tools happens at request time in claude.ts
    ...(isToolSearchEnabledOptimistic() ? [getToolSearchTool()] : []),
  ]
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple mode: only Bash, Read, and Edit tools
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // --bare + REPL mode: REPL wraps Bash/Read/Edit/etc inside the VM, so
    // return REPL instead of the raw primitives. Matches the non-bare path
    // below which also hides REPL_ONLY_TOOLS when REPL is enabled.
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(getTaskStopTool(), getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [getBashTool(), getFileReadTool(), getFileEditTool()]
    // When coordinator mode is also active, include AgentTool and TaskStopTool
    // so the coordinator gets Task+TaskStop (via useMergedTools filtering) and
    // workers get Bash/Read/Edit (via filterToolsForAgent filtering).
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(getAgentTool(), getTaskStopTool(), getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // Tools that are added conditionally (MCP resources via fetchCapabilities.ts,
  // StructuredOutput via agent hooks) — filter them out of the base set so they
  // don't appear in tool listings until the right runtime context attaches them.
  const CONDITIONAL_TOOL_NAMES = new Set([
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(
    tool => !CONDITIONAL_TOOL_NAMES.has(tool.name),
  )

  // Filter out tools that are denied by the deny rules
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // When REPL mode is enabled, hide primitive tools from direct use.
  // They're still accessible inside REPL via the VM context.
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  return allowedTools.filter(tool => cachedIsEnabled(tool))
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isToolSearchEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
