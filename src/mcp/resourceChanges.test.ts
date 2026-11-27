import { describe, expect, test } from 'bun:test'
import {
  getMcpResourceChanges,
  MAIN_THREAD,
  McpResourceChanges,
  renderMcpResourceChanges,
  resourceNoticeThread,
} from 'src/mcp/resourceChanges.js'
import type { AgentId } from 'src/shared/types/ids.js'

const README = { server: 'docs', uri: 'docs://readme' }
const TICKETS = { server: 'tickets', uri: 'tickets://open' }
const agent = (id: string) => id as AgentId

describe('resourceNoticeThread', () => {
  test('the main thread, a sub-agent by its id, and nobody for an agent that strips re-injected context', () => {
    expect(resourceNoticeThread({})).toBe(MAIN_THREAD)
    expect(resourceNoticeThread({ agentId: agent('a1') })).toBe('a1')
    expect(resourceNoticeThread({ agentId: agent('a1'), omitClaudeMdAttachments: false })).toBe('a1')
    expect(resourceNoticeThread({ agentId: agent('plan'), omitClaudeMdAttachments: true })).toBeUndefined()
  })
})

describe('McpResourceChanges', () => {
  test('a change of a resource the main thread read is told once, then gone', () => {
    const changes = new McpResourceChanges()
    changes.noteRead(MAIN_THREAD, README)
    changes.record(README)
    expect(changes.take(MAIN_THREAD)).toEqual([README])
    expect(changes.take(MAIN_THREAD)).toEqual([])
  })

  test('a change of a resource nobody read is dropped', () => {
    const changes = new McpResourceChanges()
    changes.noteRead(MAIN_THREAD, README)
    changes.record({ server: 'docs', uri: 'docs://other' })
    changes.record({ server: 'other', uri: 'docs://readme' })
    expect(changes.take(MAIN_THREAD)).toEqual([])
  })

  test('duplicates collapse and the order of arrival is kept', () => {
    const changes = new McpResourceChanges()
    changes.noteRead(MAIN_THREAD, TICKETS)
    changes.noteRead(MAIN_THREAD, README)
    changes.record(TICKETS)
    changes.record(README)
    changes.record(TICKETS)
    expect(changes.take(MAIN_THREAD)).toEqual([TICKETS, README])
  })

  test('a sub-agent is told of what it read; the main thread of that too', () => {
    const changes = new McpResourceChanges()
    changes.noteRead('a1', README)
    changes.noteRead(MAIN_THREAD, TICKETS)
    changes.record(README)
    changes.record(TICKETS)
    expect(changes.take('a1')).toEqual([README])
    expect(changes.take('a2')).toEqual([])
    expect(changes.take(MAIN_THREAD)).toEqual([README, TICKETS])
  })

  test('a forgotten resource is no longer told', () => {
    const changes = new McpResourceChanges()
    changes.noteRead(MAIN_THREAD, README)
    changes.forget(README)
    changes.record(README)
    expect(changes.take(MAIN_THREAD)).toEqual([])
  })

  test('clear forgets the reads and the pending notices, except those of preserved agents', () => {
    const changes = new McpResourceChanges()
    changes.noteRead(MAIN_THREAD, README)
    changes.noteRead('bg', TICKETS)
    changes.noteRead('gone', TICKETS)
    changes.record(README)
    changes.record(TICKETS)
    changes.clear(new Set(['bg']))
    expect(changes.take(MAIN_THREAD)).toEqual([])
    expect(changes.take('gone')).toEqual([])
    expect(changes.take('bg')).toEqual([TICKETS])

    changes.record(README)
    changes.record(TICKETS)
    expect(changes.take('bg')).toEqual([TICKETS])
    expect(changes.take(MAIN_THREAD)).toEqual([TICKETS])

    changes.clear()
    changes.record(TICKETS)
    expect(changes.take(MAIN_THREAD)).toEqual([])
  })

  test('one store per session', () => {
    expect(getMcpResourceChanges()).toBe(getMcpResourceChanges())
  })
})

describe('renderMcpResourceChanges', () => {
  test('one line per resource, naming the server and the uri', () => {
    expect(renderMcpResourceChanges([README, TICKETS])).toBe(
      'The MCP resource docs://readme on server "docs" changed since you read it. Read it again if you need its current content.\n' +
        'The MCP resource tickets://open on server "tickets" changed since you read it. Read it again if you need its current content.',
    )
  })
})
