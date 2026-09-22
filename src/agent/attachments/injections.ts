// Per-turn injection attachments: deltas (claudemd, git-status, memory,
// mcp-instructions, deferred-tools, agent-listing), small reminders
// (critical-system-reminder, output-style, team-context), token/cost
// gauges (token-usage, output-token-usage, max-budget), and ad-hoc
// signals (date-change, ultrathink-effort, context-efficiency).
//
// Extracted from src/agent/attachments/attachments.ts as part of the attachments split.
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from 'src/tools/AgentTool/prompt.js'
import { filterAgentsByMcpRequirements } from 'src/tools/AgentTool/loadAgentsDir.js'
import { filterDeniedAgents } from 'src/permissions/permissions.js'
import { getSubscriptionType } from 'src/providers/auth/auth.js'
import { mcpInfoFromString } from 'src/mcp/mcpStringUtils.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { getLocalISODate } from 'src/shared/constants/common.js'
import {
  getLastEmittedDate,
  setLastEmittedDate,
  getCurrentTurnTokenBudget,
  getTotalOutputTokens,
  getTurnOutputTokens,
  getTotalCostUSD,
} from 'src/platform/bootstrap/state.js'
import {
  hasUltrathinkKeyword,
  isUltrathinkEnabled,
} from 'src/agent/context/thinking.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaActive,
  maybeLatchLegacyDeferredAnnouncement,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from 'src/agent/tools/toolSearch.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from 'src/mcp/mcpInstructionsDelta.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { getClaudeMdDelta } from 'src/memory/instructions/claudeMdDelta.js'
import {
  getClaudeMds,
  getMemoryFiles,
  type MemoryFileInfo,
} from 'src/memory/instructions/claudemd.js'
import { countIndexEntries } from 'src/memory/memdir/memdir.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getGitStatusDelta } from 'src/vcs/git/gitStatusDelta.js'
import { getSystemContext, getUserContext } from 'src/agent/context.js'
import {
  getAgentName,
  getAgentId,
  getTeamName,
} from 'src/agent/coordinator/teammate.js'
import {
  tokenCountFromLastAPIResponse,
} from 'src/agent/context/tokens.js'
import { getEffectiveContextWindowSize } from 'src/agent/compact/autoCompact.js'
import { isEnvTruthy, getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { feature } from 'bun:bundle'
import type { Message } from 'src/shared/types/message.js'
import type {
  Attachment,
  MemoryIndexSummary,
} from 'src/agent/attachments/types.js'

/**
 * Detects when the local date has changed since the last turn (user coding
 * past midnight) and emits an attachment to notify the model.
 *
 * The date_change attachment is appended at the tail of the conversation,
 * so the model learns the new date without mutating the cached prefix.
 * messages[0] (from getUserContext → prependUserContext) intentionally
 * keeps the stale date — clearing that cache would regenerate the prefix
 * and turn the entire conversation into cache_creation on the next turn
 * (~920K effective tokens per midnight crossing per overnight session).
 *
 * Exported for testing — regression guard for the cache-clear removal.
 */
export function getDateChangeAttachments(
  toolUseContext: Pick<ToolUseContext, 'agentId'>,
): Attachment[] {
  // Main thread only, and the gate sits ahead of the one-shot read on
  // purpose. lastEmittedDate is a single process-global slot: a sub-agent
  // reaching this first would emit the notice into its own throwaway context
  // AND record the new date, so the parent — whose transcript the
  // date-sensitive work actually lives in — would never be told (#227). Same
  // swallow the plan/auto exit notices had (#224).
  if (toolUseContext.agentId) return []

  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    // First turn — just record, no attachment needed
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  return [{ type: 'date_change', newDate: currentDate }]
}

export function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  return [{ type: 'ultrathink_effort', level: 'high' }]
}

// Exported for compact.ts — the gate must be identical at both call sites.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  // The attachments pipeline runs BEFORE queryModel's latch call — settle
  // the legacy-session latch here first, or the first request of a
  // legacy-resumed session would inject the full deferred pool as a
  // persisted delta attachment AND emit the legacy prepend post-latch.
  // Subagent histories never settle the (process-wide) latch — see
  // LegacyLatchScanOptions.
  maybeLatchLegacyDeferredAnnouncement(messages ?? [], {
    subagent:
      scanContext?.callSite === 'attachments_subagent' ||
      Boolean(scanContext?.subagent),
  })
  // "Active", not just "enabled": sessions latched to the legacy prepend
  // format (resumed with a warm pre-flip cache) must not also receive
  // delta attachments — the two announcement mechanisms are exclusive.
  if (!isDeferredToolsDeltaActive()) return []
  // These three checks mirror the sync parts of isToolSearchEnabled —
  // the attachment text says "available via ToolSearch", so ToolSearch
  // has to actually be in the request. The async auto-threshold check
  // is not replicated (would double-fire tengu_tool_search_mode_decision);
  // in tst-auto below-threshold the attachment can fire while ToolSearch
  // is filtered out, but that's a narrow case and the tools announced
  // are directly callable anyway.
  if (!isToolSearchEnabledOptimistic()) return []
  if (!modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
}

/**
 * Diff the current filtered agent pool against what's already been announced
 * in this conversation (reconstructed from prior agent_listing_delta
 * attachments). Returns [] if nothing changed or the gate is off.
 *
 * The agent list was embedded in AgentTool's description, causing ~10.2% of
 * fleet cache_creation: MCP async connect, /reload-plugins, or
 * permission-mode change → description changes → full tool-schema cache bust.
 * Moving the list here keeps the tool description static.
 *
 * Exported for compact.ts — re-announces the full set after compaction eats
 * prior deltas.
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  // Skip if AgentTool isn't in the pool — the listing would be unactionable.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
  ) {
    return []
  }

  const { activeAgents, allowedAgentTypes } =
    toolUseContext.options.agentDefinitions

  // Mirror AgentTool.prompt()'s filtering: MCP requirements → deny rules →
  // allowedAgentTypes restriction. Keep this in sync with AgentTool.tsx.
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) mcpServers.add(info.serverName)
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType))
  }

  // Reconstruct announced set from prior deltas in the transcript.
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'agent_listing_delta') continue
    for (const t of msg.attachment.addedTypes) announced.add(t)
    for (const t of msg.attachment.removedTypes) announced.delete(t)
  }

  const currentTypes = new Set(filtered.map(a => a.agentType))
  const added = filtered.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  // Sort for deterministic output — agent load order is nondeterministic
  // (plugin load races, MCP async connect).
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: getSubscriptionType() !== 'pro',
    },
  ]
}

// Exported for compact.ts / reactiveCompact.ts — single source of truth for the gate.
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], [])
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}

/**
 * CLAUDE.md delta attachment — emits only the current CLAUDE.md body
 * if it changed since the last turn, or nothing on a no-op.
 * See src/memory/instructions/claudeMdDelta.ts for the diff logic.
 *
 * `omitMemoryIndexes` (a slim sub-agent, see AgentDefinition) announces the
 * family WITHOUT the two auto-memory index files. The filter is applied here
 * rather than on `getUserContext()` because that one is memoized with no
 * arguments and shared with the main thread; `getMemoryFiles()` is memoized
 * too, so the re-concatenation is a string join per turn.
 */
const notMemoryIndex = (type: MemoryType): boolean =>
  type !== 'AutoMem' && type !== 'TeamMem'

export async function getClaudeMdDeltaAttachment(
  messages: Message[] | undefined,
  options: { omitMemoryIndexes?: boolean } = {},
): Promise<Attachment[]> {
  const userContext = await getUserContext()
  let current = userContext.claudeMd ?? ''
  if (current && options.omitMemoryIndexes) {
    current = getClaudeMds(await getMemoryFiles(), notMemoryIndex)
  }
  const delta = getClaudeMdDelta(
    current,
    (messages ?? []) as Parameters<typeof getClaudeMdDelta>[1],
  )
  if (!delta) return []
  return [
    {
      type: 'claude_md_delta',
      addedContent: delta.addedContent,
      contentHash: delta.contentHash,
      isInitial: delta.isInitial,
    },
  ]
}

const isMemoryIndex = (file: MemoryFileInfo): boolean =>
  file.type === 'AutoMem' || file.type === 'TeamMem'

/** Exported for tests: pure, so it needs no module mock. */
export function toMemoryIndexSummary(file: MemoryFileInfo): MemoryIndexSummary {
  const entryCount = countIndexEntries(file.content)
  // parsing.ts keeps the untruncated body in rawContent whenever the loaded
  // content differs from disk, so the pre-truncation total is recoverable
  // without a second read. When they match, nothing was cut.
  const totalEntryCount = file.rawContent
    ? countIndexEntries(file.rawContent)
    : entryCount
  return {
    path: file.path,
    displayPath: getDisplayPath(file.path),
    kind: file.type === 'TeamMem' ? 'team' : 'auto',
    entryCount,
    totalEntryCount: Math.max(entryCount, totalEntryCount),
  }
}

const memoryIndexSignature = (
  indexes: readonly MemoryIndexSummary[],
): string =>
  indexes
    .map(i => `${i.path}:${i.entryCount}/${i.totalEntryCount}`)
    .join('|')

/**
 * Memory-index attachment — the one visible trace of the two MEMORY.md
 * indexes entering context.
 *
 * Their CONTENT ships inside `claude_md_delta` (above), which renders null
 * because it carries the whole CLAUDE.md family and no single line could name
 * it. This attachment carries no content at all — `normalizeAttachmentForAPI`
 * returns [] — so it costs nothing on the wire and exists purely so the user
 * sees the indexes load, the way `nested_memory_batch` shows loaded rules.
 *
 * Re-emits only when the signature changes (paths, entry counts, truncation),
 * so an unchanged turn announces nothing. Compaction drops the prior
 * attachment along with the rest of the history, which re-announces the
 * indexes exactly on the turn they are re-injected.
 */
export async function getMemoryIndexAttachment(
  messages: Message[] | undefined,
): Promise<Attachment[]> {
  const indexes = (await getMemoryFiles())
    .filter(isMemoryIndex)
    .map(toMemoryIndexSummary)
  if (indexes.length === 0) return []

  let lastSignature: string | null = null
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'memory_index') continue
    lastSignature = memoryIndexSignature(msg.attachment.indexes)
  }
  if (lastSignature === memoryIndexSignature(indexes)) return []

  return [{ type: 'memory_index', indexes }]
}

/**
 * gitStatus delta attachment — emits the snapshot only on the turn that
 * has no prior git_status_delta attachment. See
 * src/vcs/git/gitStatusDelta.ts for rationale (snapshot is immutable by
 * design per getGitStatus in src/agent/context.ts).
 */
export async function getGitStatusDeltaAttachment(
  messages: Message[] | undefined,
): Promise<Attachment[]> {
  const systemContext = await getSystemContext()
  const delta = getGitStatusDelta(
    systemContext.gitStatus,
    (messages ?? []) as Parameters<typeof getGitStatusDelta>[1],
  )
  if (!delta) return []
  return [{ type: 'git_status_delta', content: delta.content }]
}

export function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

export function getOutputStyleAttachment(): Attachment[] {
  const settings = getInitialSettings()
  const outputStyle = settings?.outputStyle || 'default'

  // Only show for non-default styles
  if (outputStyle === 'default') {
    return []
  }

  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}

export function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // Only inject for teammates (not team lead or non-team sessions)
  if (!teamName || !agentId) {
    return []
  }

  // Only inject on first turn - check if there are no assistant messages yet
  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }

  const configDir = getClaudinConfigHomeDir()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`

  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}

export function getTokenUsageAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!isEnvTruthy(process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }

  const contextWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountFromLastAPIResponse(messages)

  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

export function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

export function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}
