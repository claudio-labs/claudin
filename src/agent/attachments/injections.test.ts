// What the small per-turn producers in injections.ts emit, pinned before the
// CLAUDE.md and git-status deltas change where they read from. Each case is a
// producer's contract as the pipeline uses it: nothing on a no-op, the same
// payload for the same history.
import { afterEach, describe, expect, test } from 'bun:test'

import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import type { Message } from 'src/shared/types/message.js'
import {
  getAgentListingDeltaAttachment,
  getCriticalSystemReminderAttachment,
  getMaxBudgetUsdAttachment,
  getTokenUsageAttachment,
  getUltrathinkEffortAttachment,
} from 'src/agent/attachments/injections.js'

function agent(agentType: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType,
    whenToUse: `use ${agentType}`,
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
    ...extra,
  } as AgentDefinition
}

function contextWith(args: {
  toolNames?: string[]
  agents?: AgentDefinition[]
  allowedAgentTypes?: string[]
  reminder?: string
}): ToolUseContext {
  return {
    options: {
      tools: (args.toolNames ?? [AGENT_TOOL_NAME]).map(name => ({ name, aliases: [] })),
      agentDefinitions: {
        activeAgents: args.agents ?? [],
        allAgents: args.agents ?? [],
        allowedAgentTypes: args.allowedAgentTypes,
      },
    },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    criticalSystemReminder_EXPERIMENTAL: args.reminder,
  } as unknown as ToolUseContext
}

function listingDelta(addedTypes: string[], removedTypes: string[] = []): Message {
  return {
    type: 'attachment',
    attachment: { type: 'agent_listing_delta', addedTypes, addedLines: [], removedTypes, isInitial: false },
  } as unknown as Message
}

describe('getAgentListingDeltaAttachment', () => {
  test('says nothing when the Agent tool is not in the pool', () => {
    const context = contextWith({ toolNames: ['Read'], agents: [agent('Explore')] })
    expect(getAgentListingDeltaAttachment(context, [])).toEqual([])
  })

  test('the first listing names every agent, sorted, and is marked initial', () => {
    const context = contextWith({ agents: [agent('Plan'), agent('Code'), agent('Explore')] })
    const [delta] = getAgentListingDeltaAttachment(context, [])
    expect(delta).toMatchObject({
      type: 'agent_listing_delta',
      addedTypes: ['Code', 'Explore', 'Plan'],
      removedTypes: [],
      isInitial: true,
    })
    expect((delta as { addedLines: string[] }).addedLines).toHaveLength(3)
  })

  test('says nothing once every agent was announced', () => {
    const context = contextWith({ agents: [agent('Code'), agent('Explore')] })
    expect(getAgentListingDeltaAttachment(context, [listingDelta(['Code', 'Explore'])])).toEqual([])
  })

  test('a later listing carries only what was added and what went away', () => {
    const context = contextWith({ agents: [agent('Code'), agent('Zeta'), agent('Alpha')] })
    const [delta] = getAgentListingDeltaAttachment(context, [listingDelta(['Code', 'Gone', 'Explore'])])
    expect(delta).toMatchObject({
      addedTypes: ['Alpha', 'Zeta'],
      removedTypes: ['Explore', 'Gone'],
      isInitial: false,
    })
  })

  test('an announced agent that a later delta removed is announced again', () => {
    const context = contextWith({ agents: [agent('Code')] })
    const history = [listingDelta(['Code']), listingDelta([], ['Code'])]
    expect(getAgentListingDeltaAttachment(context, history)[0]).toMatchObject({ addedTypes: ['Code'] })
  })

  test('allowedAgentTypes narrows the listing', () => {
    const context = contextWith({ agents: [agent('Code'), agent('Explore')], allowedAgentTypes: ['Explore'] })
    expect(getAgentListingDeltaAttachment(context, [])[0]).toMatchObject({ addedTypes: ['Explore'] })
  })

  test('an agent whose MCP server is not connected is left out', () => {
    const context = contextWith({ agents: [agent('Code'), agent('NeedsDb', { requiredMcpServers: ['db'] })] })
    expect(getAgentListingDeltaAttachment(context, [])[0]).toMatchObject({ addedTypes: ['Code'] })
  })
})

describe('getMaxBudgetUsdAttachment', () => {
  test('says nothing without a budget', () => {
    expect(getMaxBudgetUsdAttachment(undefined)).toEqual([])
  })

  test('reports what is left of the budget', () => {
    const [budget] = getMaxBudgetUsdAttachment(5) as Array<{ type: string; used: number; total: number; remaining: number }>
    expect(budget!.type).toBe('budget_usd')
    expect(budget!.total).toBe(5)
    expect(budget!.remaining).toBeCloseTo(5 - budget!.used, 10)
  })
})

describe('getTokenUsageAttachment', () => {
  const saved = process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT
    else process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT = saved
  })

  test('is off unless the env asks for it', () => {
    delete process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT
    expect(getTokenUsageAttachment([], 'claude-opus-5-5')).toEqual([])
  })

  test('reports the window and what an empty history has used of it', () => {
    process.env.CLAUDIN_ENABLE_TOKEN_USAGE_ATTACHMENT = '1'
    const [usage] = getTokenUsageAttachment([], 'claude-opus-5-5') as Array<{ type: string; used: number; total: number; remaining: number }>
    expect(usage!.type).toBe('token_usage')
    expect(usage!.used).toBe(0)
    expect(usage!.total).toBeGreaterThan(0)
    expect(usage!.remaining).toBe(usage!.total)
  })
})

describe('the one-line reminders', () => {
  test('a critical reminder rides only when the context carries one', () => {
    expect(getCriticalSystemReminderAttachment(contextWith({}))).toEqual([])
    expect(getCriticalSystemReminderAttachment(contextWith({ reminder: 'read-only' }))).toEqual([
      { type: 'critical_system_reminder', content: 'read-only' },
    ])
  })

  test('no input means no ultrathink attachment', () => {
    expect(getUltrathinkEffortAttachment(null)).toEqual([])
  })
})
