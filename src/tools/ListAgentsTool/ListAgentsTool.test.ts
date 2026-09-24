import { afterEach, describe, expect, test } from 'bun:test'

import type { AppState } from 'src/terminal/state/AppState.js'
import {
  collectSubagents,
  collectTeammates,
  ListAgentsTool,
} from 'src/tools/ListAgentsTool/ListAgentsTool.js'
import {
  formatAgentListing,
  SECTION_ROW_CAP,
} from 'src/tools/ListAgentsTool/format.js'

afterEach(() => {
  delete process.env.CLAUDIN_DISABLE_SEND_MESSAGE
})

function agentTask(
  agentId: string,
  description: string,
  status: string,
  isBackgrounded = true,
) {
  return {
    type: 'local_agent',
    agentType: 'Code',
    agentId,
    description,
    status,
    isBackgrounded,
  }
}

function appState(
  tasks: Record<string, unknown>,
  names: [string, string][] = [],
): Pick<AppState, 'tasks' | 'agentNameRegistry'> {
  return {
    tasks,
    agentNameRegistry: new Map(names),
  } as unknown as Pick<AppState, 'tasks' | 'agentNameRegistry'>
}

describe('collectSubagents', () => {
  test('lists each agent under the name a send resolves, with its status', () => {
    const rows = collectSubagents(
      appState(
        {
          a1: agentTask('a1', 'Map the registry', 'running'),
          a2: agentTask('a2', 'Read the docs', 'completed'),
          a3: agentTask('a3', 'Inline helper', 'running', false),
        },
        [['researcher', 'a1']],
      ),
      undefined,
    )
    expect(rows).toEqual([
      { name: 'researcher', details: ['running', 'Map the registry'] },
      { name: 'a2', details: ['finished', 'Read the docs'] },
      { name: 'a3', details: ['running inline', 'Inline helper'] },
    ])
  })

  test('keeps a named agent whose task was evicted — a send still resumes it', () => {
    const rows = collectSubagents(appState({}, [['old', 'a9']]), undefined)
    expect(rows).toEqual([{ name: 'old', details: ['finished'] }])
  })

  test('leaves out the calling agent and the main session', () => {
    const rows = collectSubagents(
      appState({
        a1: agentTask('a1', 'me', 'running'),
        m: { ...agentTask('m', 'main', 'running'), agentType: 'main-session' },
      }),
      'a1',
    )
    expect(rows).toEqual([])
  })
})

test('collectTeammates names the lead for a member, and skips the caller', () => {
  const team = {
    teamName: 't',
    selfAgentName: 'alice',
    isLeader: false,
    teammates: {
      x: { name: 'alice', agentType: 'Code' },
      y: { name: 'bob', agentType: 'Explore' },
    },
  }
  expect(
    collectTeammates({ teamContext: team } as unknown as Pick<AppState, 'teamContext'>),
  ).toEqual([
    { name: 'team-lead', details: ['team lead'] },
    { name: 'bob', details: ['Explore'] },
  ])
})

describe('formatAgentListing', () => {
  test('prints one section per kind, name first', () => {
    expect(
      formatAgentListing({
        subagents: [{ name: 'researcher', details: ['running', 'Map it'] }],
        teammates: [],
      }),
    ).toBe('Subagents (1):\n  researcher  ·  running  ·  Map it')
  })

  test('says how to get an agent when there is none', () => {
    expect(formatAgentListing({ subagents: [], teammates: [] })).toContain(
      'No agents to message yet',
    )
  })

  test('caps a section and says how many rows it left out', () => {
    const rows = Array.from({ length: SECTION_ROW_CAP + 3 }, (_, i) => ({
      name: `agent-${i}`,
      details: [],
    }))
    const text = formatAgentListing({ subagents: rows, teammates: [] })
    expect(text).toContain(`Subagents (${SECTION_ROW_CAP + 3}):`)
    expect(text).toContain('(… 3 more not shown)')
    expect(text).not.toContain(`agent-${SECTION_ROW_CAP}\n`)
  })
})

test('ListAgents is deferred, read-only and off under the SendMessage killswitch', () => {
  expect(ListAgentsTool.shouldDefer).toBe(true)
  expect(ListAgentsTool.isReadOnly()).toBe(true)
  expect(ListAgentsTool.isEnabled()).toBe(true)
  process.env.CLAUDIN_DISABLE_SEND_MESSAGE = '1'
  expect(ListAgentsTool.isEnabled()).toBe(false)
})
