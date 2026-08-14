// Skill listing + bash/git instructions gates.
//
// Two per-process latches (per-agent keyed) that emit a one-shot attachment
// the first time each agent in this process needs it, with explicit reset
// hooks for skill-set changes / plugin reloads and a suppress hook for
// --resume so a prior process's attachment isn't re-emitted.
//
// Extracted from src/utils/attachments.ts as part of the attachments split.
import {
  toolMatchesName,
  type ToolUseContext,
} from 'src/Tool.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import {
  getBashGitInstructionsBody,
  shouldInjectBashGitInstructionsInMessages,
} from 'src/tools/BashTool/prompt.js'
import { shouldIncludeGitInstructions } from 'src/utils/gitSettings.js'
import {
  getSkillToolCommands,
  getMcpSkillCommands,
} from 'src/commands.js'
import type { Command } from 'src/types/command.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from 'src/bootstrap/state.js'
import { formatCommandsWithinBudget } from 'src/tools/SkillTool/prompt.js'
import { getContextWindowForModel } from 'src/utils/context.js'
import { getSdkBetas } from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { feature } from 'bun:bundle'
import type { Attachment } from './types.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js'),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Track which skills have been sent to avoid re-sending. Keyed by agentId
// (empty string = main thread) so subagents get their own turn-0 listing —
// without per-agent scoping, the main thread populating this Set would cause
// every subagent's filterToBundledAndMcp result to dedup to empty.
const sentSkillNames = new Map<string, Set<string>>()
let suppressNext = false

// Called when the skill set genuinely changes (plugin reload, skill file
// change on disk) so new skills get announced. NOT called on compact —
// post-compact re-injection costs ~4K tokens/event for marginal benefit.
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

/**
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the
 * transcript.
 *
 * `sentSkillNames` is module-scope — process-local. Each `claude -p` spawn
 * starts with an empty Map, so without this every resume re-injects the
 * full ~600-token listing even though it's already in the conversation from
 * the prior process. Shows up on every --resume; particularly loud for
 * daemons that respawn frequently.
 *
 * Trade-off: skills added between sessions won't be announced until the
 * next non-resume session. Acceptable — skill_listing was never meant to
 * cover cross-process deltas, and the agent can still call them (they're
 * in the Skill tool's runtime registry regardless).
 */
export function suppressNextSkillListing(): void {
  suppressNext = true
}

/**
 * Test-only inspector. Returns a read-only snapshot of the skill-listing
 * latch state so unit tests can verify reset/suppress semantics without
 * exposing the mutable Map. Not part of the public surface — do not call
 * from production code.
 */
export function _getSkillLatchSnapshotForTests(): {
  suppressNext: boolean
  sentByAgent: Record<string, string[]>
} {
  const sentByAgent: Record<string, string[]> = {}
  for (const [agentKey, names] of sentSkillNames.entries()) {
    sentByAgent[agentKey] = Array.from(names)
  }
  return { suppressNext, sentByAgent }
}

/**
 * Test-only seed. Populates `sentSkillNames` for a specific agentKey so
 * tests can simulate prior emissions without invoking the heavy
 * getSkillListingAttachments pipeline.
 */
export function _seedSentSkillNamesForTests(
  agentKey: string,
  names: string[],
): void {
  sentSkillNames.set(agentKey, new Set(names))
}

// When skill-search is enabled and the filtered (bundled + MCP) listing exceeds
// this count, fall back to bundled-only. Protects MCP-heavy users (100+ servers)
// from truncation while keeping the turn-0 guarantee for typical setups.
const FILTERED_LISTING_MAX = 30

/**
 * Filter skills to bundled + MCP (user-connected) only.
 * Used when skill-search is enabled to resolve the turn-0 gap for subagents:
 * these sources are small, intent-signaled, and won't hit the truncation budget.
 * User/project/plugin skills (the long tail — 200+) go through discovery instead.
 *
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(
    cmd => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp',
  )
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter(cmd => cmd.loadedFrom === 'bundled')
  }
  return filtered
}

export async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  // Skip skill listing for agents that don't have the Skill tool — they can't use skills directly.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))
  ) {
    return []
  }

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(
    toolUseContext.getAppState().mcp.commands,
  )
  let allCommands =
    mcpSkills.length > 0
      ? uniqBy([...localCommands, ...mcpSkills], 'name')
      : localCommands

  // When skill search is active, filter to bundled + MCP instead of full
  // suppression. Resolves the turn-0 gap: main thread gets turn-0 discovery
  // via getTurnZeroSkillDiscovery (blocking), but subagents use the async
  // subagent_spawn signal (collected post-tools, visible turn 1). Bundled +
  // MCP are small and intent-signaled; user/project/plugin skills go through
  // discovery. feature() first for DCE — the property-access string leaks
  // otherwise even with ?. on null.
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchModules?.featureCheck.isSkillSearchEnabled()
  ) {
    allCommands = filterToBundledAndMcp(allCommands)
  }

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // Resume path: prior process already injected a listing; it's in the
  // transcript. Mark everything current as sent so only post-resume deltas
  // (skills loaded later via /reload-plugins etc) get announced.
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  // Find skills we haven't sent yet
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))

  if (newSkills.length === 0) {
    return []
  }

  // If no skills have been sent yet, this is the initial batch
  const isInitial = sent.size === 0

  // Mark as sent
  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`,
  )

  // Format within budget using existing logic
  const contextWindowTokens = getContextWindowForModel(
    toolUseContext.options.mainLoopModel,
    getSdkBetas(),
  )
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}

// Agents that have already received the bash_git_instructions attachment in
// this process. Keyed by agentId (empty string = main thread) for parity with
// sentSkillNames — without per-agent scoping a subagent inheriting the main
// thread's emission state would never receive its own copy.
//
// The body is a single binary blob: either the full git/PR protocol or
// nothing. There's no delta to track, so a Set of agentIds is enough — once
// emitted, never re-emit. Re-emitting on every agentic-loop iteration would
// add ~3.5KB of fresh user content per turn, dwarfing the ~6.4KB the move
// saved from the tool schema after only two iterations.
const sentBashGitInstructions = new Set<string>()
let suppressNextBashGitInstructionsFlag = false

/**
 * Reset emission state. With no argument, clears every agent's slot AND the
 * resume suppress latch — used by /clear which wipes the whole conversation.
 *
 * With an explicit `agentKey`, deletes only that slot. Used by
 * runPostCompactCleanup so a subagent's compact can't accidentally wipe the
 * main thread's "already sent" mark and force re-injection there. The
 * suppress latch is process-global and not touched in the targeted case —
 * compact never overlaps with resume.
 *
 * Pass `''` to target the main thread (matches the agentKey convention used
 * by getBashGitInstructionsAttachment).
 */
export function resetSentBashGitInstructions(agentKey?: string): void {
  if (agentKey !== undefined) {
    sentBashGitInstructions.delete(agentKey)
    return
  }
  sentBashGitInstructions.clear()
  suppressNextBashGitInstructionsFlag = false
}

/**
 * Suppress the next bash_git_instructions injection. Called by
 * conversationRecovery when an attachment of this type is already in the
 * resumed transcript so we don't re-emit ~3.5KB the model can already see.
 *
 * `sentBashGitInstructions` is module-scope — process-local. Each `claude -p`
 * spawn starts with an empty Set, so without this every --resume re-injects
 * the full block. Fire-once latch; consumed on the first emission attempt.
 */
export function suppressNextBashGitInstructions(): void {
  suppressNextBashGitInstructionsFlag = true
}

export async function getBashGitInstructionsAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  if (!shouldInjectBashGitInstructionsInMessages()) {
    return []
  }

  // Skip git instructions for agents without the Bash tool — they can't run
  // git or gh commands, so the protocol is dead weight.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // Mirror the gate the inline path used to apply in getCommitAndPRInstructions.
  if (!shouldIncludeGitInstructions()) {
    return []
  }

  const agentKey = toolUseContext.agentId ?? ''

  // Resume path: prior process already injected the block; it's in the
  // transcript. Mark the current agent as sent so we don't double-inject,
  // then bail. Latch is one-shot — the next agent that calls this still
  // gets the regular emission.
  if (suppressNextBashGitInstructionsFlag) {
    suppressNextBashGitInstructionsFlag = false
    sentBashGitInstructions.add(agentKey)
    return []
  }

  if (sentBashGitInstructions.has(agentKey)) {
    return []
  }
  sentBashGitInstructions.add(agentKey)

  return [
    {
      type: 'bash_git_instructions',
      content: getBashGitInstructionsBody(),
    },
  ]
}
