// Per-turn injection attachments: deltas (claudemd, git-status, memory,
// mcp-instructions, deferred-tools, agent-listing), small reminders
// (critical-system-reminder, output-style, team-context), token/cost
// gauges (token-usage, output-token-usage, max-budget), and ad-hoc
// signals (date-change, ultrathink-effort, context-efficiency).
//
// Extracted from src/utils/attachments.ts as part of the attachments split.
import {
  logEvent,
} from '../../services/analytics/index.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
} from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '../../tools/AgentTool/prompt.js'
import { filterAgentsByMcpRequirements } from '../../tools/AgentTool/loadAgentsDir.js'
import { filterDeniedAgents } from '../permissions/permissions.js'
import { getSubscriptionType } from '../auth.js'
import { mcpInfoFromString } from '../../services/mcp/mcpStringUtils.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { getLocalISODate } from '../../constants/common.js'
import {
  getLastEmittedDate,
  setLastEmittedDate,
  getKairosActive,
  getCurrentTurnTokenBudget,
  getTotalOutputTokens,
  getTurnOutputTokens,
  getTotalCostUSD,
} from '../../bootstrap/state.js'
import {
  hasUltrathinkKeyword,
  isUltrathinkEnabled,
} from '../thinking.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaActive,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../toolSearch.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
} from '../mcpInstructionsDelta.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getClaudeMdDelta } from '../claudeMdDelta.js'
import { getGitStatusDelta } from '../gitStatusDelta.js'
import { getMemoryDelta, type MemoryFileInput } from '../memoryDelta.js'
import { getSystemContext, getUserContext } from '../../context.js'
import {
  getAgentName,
  getAgentId,
  getTeamName,
} from '../teammate.js'
import {
  tokenCountFromLastAPIResponse,
} from '../tokens.js'
import { getEffectiveContextWindowSize } from '../../services/compact/autoCompact.js'
import { isEnvTruthy, getClaudinConfigHomeDir } from '../envUtils.js'
import { feature } from 'bun:bundle'
import type { Message } from 'src/types/message.js'
import type { Attachment } from './types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const sessionTranscriptModule = feature('KAIROS')
  ? (require('../../services/sessionTranscript/sessionTranscript.js') as typeof import('../../services/sessionTranscript/sessionTranscript.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

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
  messages: Message[] | undefined,
): Attachment[] {
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

  // Assistant mode: flush yesterday's transcript to the per-day file so
  // the /dream skill (1–5am local) finds it even if no compaction fires
  // today. Fire-and-forget; writeSessionTranscriptSegment buckets by
  // message timestamp so a multi-day gap flushes each day correctly.
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate)
    }
  }

  return [{ type: 'date_change', newDate: currentDate }]
}

export function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('tengu_ultrathink', {})
  return [{ type: 'ultrathink_effort', level: 'high' }]
}

// Exported for compact.ts — the gate must be identical at both call sites.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
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
 * See src/utils/claudeMdDelta.ts for the diff logic.
 */
export async function getClaudeMdDeltaAttachment(
  messages: Message[] | undefined,
): Promise<Attachment[]> {
  const userContext = await getUserContext()
  const current = userContext.claudeMd ?? ''
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

/**
 * gitStatus delta attachment — emits the snapshot only on the turn that
 * has no prior git_status_delta attachment. See
 * src/utils/gitStatusDelta.ts for rationale (snapshot is immutable by
 * design per getGitStatus in src/context.ts).
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

/**
 * Nested-memory delta attachment — reconstructs the current nested
 * memory set from `nested_memory` attachments emitted in PRIOR turns
 * (already part of `messages`), diffs against prior `memory_delta`
 * attachments, and emits only added/changed content + retraction
 * names. See src/utils/memoryDelta.ts.
 *
 * 📌 NOT A RACE: although this wrapper runs in the same Promise.all
 * batch as `getNestedMemoryAttachments` (see `allThreadAttachments`
 * in getAttachments), it reads `messages` — the INPUT parameter,
 * which is the accumulated conversation up through the last completed
 * turn. New outputs of THIS turn aren't in `messages` yet; they get
 * appended by the caller after getAttachments returns. So the scanner
 * only ever sees prior-turn `nested_memory`, and that is by design:
 *   Turn 1: scanner sees no prior nested_memory → returns null.
 *   Turn 2+: scanner sees turn 1's nested_memory → emits memory_delta.
 *
 * ⚠️ INTENTIONAL ASYMMETRY vs the three sibling deltas
 * (`claudeMdDelta`, `gitStatusDelta`, `todoReminderDelta`). Those three
 * REPLACE their raw counterpart: `filterStaticDedupKeys` (in
 * src/utils/api.ts) strips `claudeMd` / `gitStatus` from the
 * system/user context so they only flow through the delta.
 * memory_delta, by contrast, COEXISTS with raw `nested_memory` — raw
 * still fires every turn because downstream consumers
 * (claude.ts::getSystemBlocksWithScope prompt-cache scoping;
 * getUserContext memory injection) read `nested_memory` directly and
 * don't understand the delta shape yet. The result: turn 2 carries
 * memory content twice (raw + delta) before stabilizing from turn 3+.
 *
 * Model-context invariant: the model NEVER loses access to memory
 * because raw nested_memory continues emitting on every turn. The
 * delta is a COMPLEMENT that sets up future savings once consumers
 * migrate — not a replacement that could drop content.
 *
 * TODO(follow-up, separate PR): teach getSystemBlocksWithScope and
 * getUserContext to read from `memory_delta`, then drop raw
 * `nested_memory` to match the other three deltas. Expected
 * additional savings: ~9KB per turn 2+ of redundant memory content on
 * 3P providers without cache.
 */
export function getMemoryDeltaAttachment(
  messages: Message[] | undefined,
): Attachment[] {
  // The "current" set is reconstructed from nested_memory attachments
  // produced earlier in the same turn (the caller invokes them ahead
  // of this delta in allThreadAttachments). We also look at nested
  // memory entries from prior turns to build the present snapshot.
  //
  // Reading from the transcript keeps this function pure (no
  // filesystem I/O) — the authoritative source for "what memory is
  // currently loaded" is the attachments generated upstream.
  const current: MemoryFileInput[] = []
  const seen = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'nested_memory') continue
    const path = msg.attachment.path
    if (seen.has(path)) continue
    seen.add(path)
    current.push({
      path,
      content: msg.attachment.content.content ?? '',
    })
  }

  const delta = getMemoryDelta(
    current,
    (messages ?? []) as Parameters<typeof getMemoryDelta>[1],
  )
  if (!delta) return []
  return [
    {
      type: 'memory_delta',
      addedNames: delta.addedNames,
      addedContent: delta.addedContent,
      addedHashes: delta.addedHashes,
      removedNames: delta.removedNames,
      isInitial: delta.isInitial,
    },
  ]
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
  const settings = getSettings_DEPRECATED()
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
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
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

/**
 * Context-efficiency nudge. Injected after every N tokens of growth without
 * a snip. Pacing is handled entirely by shouldNudgeForSnips — the 10k
 * interval resets on prior nudges, snip markers, snip boundaries, and
 * compact boundaries.
 */
export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  if (!feature('HISTORY_SNIP')) {
    return []
  }
  // Gate must match SnipTool.isEnabled() — don't nudge toward a tool that
  // isn't in the tool list. Lazy require keeps this file snip-string-free.
  const { isSnipRuntimeEnabled, shouldNudgeForSnips } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../services/compact/snipCompact.js') as typeof import('../../services/compact/snipCompact.js')
  if (!isSnipRuntimeEnabled()) {
    return []
  }

  if (!shouldNudgeForSnips(messages)) {
    return []
  }

  return [{ type: 'context_efficiency' }]
}
