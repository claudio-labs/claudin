import { afterEach, describe, expect, test } from 'bun:test'

import type { AppState } from 'src/terminal/state/AppState.js'
import type { SessionDirectory } from 'src/sessions/peers/registry.js'
import {
  collectPeers,
  collectSubagents,
  collectTeammates,
  describeSelf,
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

const empty = { subagents: [], teammates: [], peers: [], notes: [] }

describe('formatAgentListing', () => {
  test('prints one section per kind, name first', () => {
    expect(
      formatAgentListing({
        ...empty,
        subagents: [{ name: 'researcher', details: ['running', 'Map it'] }],
      }),
    ).toBe('Subagents (1):\n  researcher  ·  running  ·  Map it')
  })

  test('leads with how this session is addressed and ends with the notes', () => {
    const text = formatAgentListing({
      ...empty,
      self: 'This session is claudin [3fa9c1]',
      peers: [{ name: 'claudin-goal [8c21d0]', details: ['idle', '~/w/claudin-goal'] }],
      notes: ['a note'],
    })
    expect(text).toBe(
      'This session is claudin [3fa9c1]\n\nPeer sessions (1):\n  claudin-goal [8c21d0]  ·  idle  ·  ~/w/claudin-goal\n\na note',
    )
  })

  test('says how to get an agent when there is none', () => {
    expect(formatAgentListing(empty)).toContain(
      'No agents to message yet',
    )
  })

  test('caps a section and says how many rows it left out', () => {
    const rows = Array.from({ length: SECTION_ROW_CAP + 3 }, (_, i) => ({
      name: `agent-${i}`,
      details: [],
    }))
    const text = formatAgentListing({ ...empty, subagents: rows })
    expect(text).toContain(`Subagents (${SECTION_ROW_CAP + 3}):`)
    expect(text).toContain('(… 3 more not shown)')
    expect(text).not.toContain(`agent-${SECTION_ROW_CAP}\n`)
  })
})

describe('peer sessions', () => {
  const directory: SessionDirectory = {
    self: { name: 'claudin', ref: '3fa9c1' },
    peers: [
      {
        pid: 2,
        name: 'claudin-goal',
        hash: '8c21d0ff',
        ref: '8c21d0',
        socketPath: '/s/2.sock',
        token: 't',
        cwd: '/w/claudin-goal',
        startedAt: Date.parse('2026-09-24T10:00:00Z'),
        status: 'idle',
      },
    ],
  }

  test('a peer row is its address, then status, directory and age', () => {
    const [row] = collectPeers(directory, new Date('2026-09-24T12:00:00Z'))
    expect(row?.name).toBe('claudin-goal [8c21d0]')
    expect(row?.details.slice(0, 2)).toEqual(['idle', '/w/claudin-goal'])
    expect(row?.details[2]).toStartWith('started 2')
  })

  test('the self line needs an inbox; without one a note says why nobody can write', () => {
    expect(describeSelf(directory, true).self).toContain(
      'This session is claudin [3fa9c1]',
    )
    const headless = describeSelf(directory, false)
    expect(headless.self).toBeUndefined()
    expect(headless.notes[0]).toContain('has no inbox')
  })
})

test('ListAgents is deferred, read-only and off under the SendMessage killswitch', () => {
  expect(ListAgentsTool.shouldDefer).toBe(true)
  expect(ListAgentsTool.isReadOnly()).toBe(true)
  expect(ListAgentsTool.isEnabled()).toBe(true)
  process.env.CLAUDIN_DISABLE_SEND_MESSAGE = '1'
  expect(ListAgentsTool.isEnabled()).toBe(false)
})
