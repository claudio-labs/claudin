/**
 * mcp/core, part 5: announcing MCP server instructions to the model.
 *
 * Server instructions reach the model only as `mcp_instructions_delta`
 * attachments kept in the conversation. `getMcpInstructionsDelta` reads the
 * attachments already in the history to learn which servers have been
 * announced, compares that with the servers connected now, and returns what
 * to add and what to retract, or null when there is nothing new.
 *
 * The blocks it returns are model-facing text. The facts each block must
 * carry are pinned here: a level-2 heading with the exact server name on the
 * first line, then the instructions verbatim.
 */
import { describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from 'src/agent/attachments/shared.js'
import { createUserMessage } from 'src/agent/messages/factories.js'
import { type ClientSideInstruction, getMcpInstructionsDelta, type McpInstructionsDelta } from 'src/mcp/mcpInstructionsDelta.js'
import type { MCPServerConnection } from 'src/mcp/types.js'
import type { Message } from 'src/shared/types/message.js'

const http = { type: 'http' as const, url: 'https://h.example/mcp', scope: 'project' as const }

function connected(name: string, instructions?: string): MCPServerConnection {
  return {
    name,
    type: 'connected',
    client: {} as never,
    capabilities: {},
    config: http,
    cleanup: async () => {},
    ...(instructions === undefined ? {} : { instructions }),
  }
}

function other(name: string, type: 'failed' | 'needs-auth' | 'pending' | 'disabled'): MCPServerConnection {
  return { name, type, config: http } as MCPServerConnection
}

function announced(addedNames: string[], removedNames: string[] = []): Message {
  return createAttachmentMessage({
    type: 'mcp_instructions_delta',
    addedNames,
    addedBlocks: addedNames.map(n => `## ${n}\n(earlier)`),
    removedNames,
  }) as Message
}

const say = (text: string): Message => createUserMessage({ content: text }) as Message

describe('a fresh conversation', () => {
  test('announces every connected server with instructions, sorted by name', () => {
    const delta = getMcpInstructionsDelta(
      [connected('zeta', 'Z rules.'), connected('alpha', 'Use alpha for search.\nNever delete.'), connected('mute')],
      [],
      [],
    )
    expect(delta).toEqual({
      addedNames: ['alpha', 'zeta'],
      addedBlocks: ['## alpha\nUse alpha for search.\nNever delete.', '## zeta\nZ rules.'],
      removedNames: [],
    })
  })

  test('the heading carries the server name exactly as configured, not folded', () => {
    const delta = getMcpInstructionsDelta([connected('my.server v2', 'Hi.')], [], [])
    expect(delta?.addedBlocks[0]?.split('\n')[0]).toBe('## my.server v2')
  })

  const silent: Array<[label: string, clients: MCPServerConnection[]]> = [
    ['no servers', []],
    ['servers without instructions', [connected('a'), connected('b')]],
    ['empty instructions count as none', [connected('a', '')]],
    ['servers that are not connected', [other('f', 'failed'), other('n', 'needs-auth'), other('p', 'pending'), other('d', 'disabled')]],
  ]
  test.each(silent)('returns null with %s', (_label, clients) => {
    expect(getMcpInstructionsDelta(clients, [], [])).toBeNull()
  })

  test('a server that is not connected is not announced even if it would have instructions', () => {
    const pending = { ...other('p', 'pending'), instructions: 'never shown' } as MCPServerConnection
    expect(getMcpInstructionsDelta([pending, connected('c', 'shown')], [], [])?.addedNames).toEqual(['c'])
  })

  test('the added names sort by locale order', () => {
    const delta = getMcpInstructionsDelta([connected('beta', 'b'), connected('Alpha', 'A'), connected('alpha', 'a')], [], [])
    expect(delta?.addedNames).toEqual(['alpha', 'Alpha', 'beta'])
    expect(delta?.addedBlocks).toEqual(['## alpha\na', '## Alpha\nA', '## beta\nb'])
  })
})

describe('reading the history', () => {
  test('a server already announced is not announced again', () => {
    expect(getMcpInstructionsDelta([connected('a', 'x')], [announced(['a'])], [])).toBeNull()
  })

  test('only the name matters: new text for an announced server is not re-sent', () => {
    expect(getMcpInstructionsDelta([connected('a', 'changed text')], [announced(['a'])], [])).toBeNull()
  })

  test('a server announced and later retracted is announced again', () => {
    const history = [announced(['a']), say('hi'), announced([], ['a'])]
    expect(getMcpInstructionsDelta([connected('a', 'back')], history, [])).toEqual({
      addedNames: ['a'],
      addedBlocks: ['## a\nback'],
      removedNames: [],
    })
  })

  test('the history is read in order: an add after a removal stands', () => {
    const history = [announced([], ['a']), announced(['a'])]
    expect(getMcpInstructionsDelta([connected('a', 'x')], history, [])).toBeNull()
  })

  test('messages and attachments of other kinds are ignored', () => {
    const history = [
      say('mcp_instructions_delta'),
      createAttachmentMessage({ type: 'claude_md_delta', addedContent: 'x', contentHash: 'h', isInitial: true } as never) as Message,
    ]
    expect(getMcpInstructionsDelta([connected('a', 'x')], history, [])?.addedNames).toEqual(['a'])
  })
})

describe('retractions', () => {
  const cases: Array<[label: string, clients: MCPServerConnection[], history: Message[], out: McpInstructionsDelta | null]> = [
    ['an announced server that disappeared', [], [announced(['gone'])], { addedNames: [], addedBlocks: [], removedNames: ['gone'] }],
    ['an announced server that is now pending (a reconnect)', [other('a', 'pending')], [announced(['a'])], { addedNames: [], addedBlocks: [], removedNames: ['a'] }],
    ['an announced server that failed', [other('a', 'failed')], [announced(['a'])], { addedNames: [], addedBlocks: [], removedNames: ['a'] }],
    ['an announced server still connected but now without instructions is kept', [connected('a')], [announced(['a'])], null],
    [
      'adds and removals in one delta',
      [connected('new', 'n')],
      [announced(['old'])],
      { addedNames: ['new'], addedBlocks: ['## new\nn'], removedNames: ['old'] },
    ],
  ]
  test.each(cases)('%s', (_label, clients, history, out) => {
    expect(getMcpInstructionsDelta(clients, history, [])).toEqual(out)
  })

  test('removed names sort by code unit, unlike added names', () => {
    const delta = getMcpInstructionsDelta([], [announced(['beta', 'alpha', 'Alpha'])], [])
    expect(delta?.removedNames).toEqual(['Alpha', 'alpha', 'beta'])
  })
})

describe('client-side instructions', () => {
  const extra = (serverName: string, block: string): ClientSideInstruction => ({ serverName, block })

  test('a client-side block is appended to the server\'s own instructions after a blank line', () => {
    const delta = getMcpInstructionsDelta([connected('browser', 'Server says.')], [], [extra('browser', 'Client adds.')])
    expect(delta?.addedBlocks).toEqual(['## browser\nServer says.\n\nClient adds.'])
  })

  test('a server with no instructions of its own gets a block from the client side alone', () => {
    const delta = getMcpInstructionsDelta([connected('browser')], [], [extra('browser', 'Client only.')])
    expect(delta).toEqual({ addedNames: ['browser'], addedBlocks: ['## browser\nClient only.'], removedNames: [] })
  })

  test('several client-side blocks for one server are appended in order', () => {
    const delta = getMcpInstructionsDelta([connected('b')], [], [extra('b', 'one'), extra('b', 'two')])
    expect(delta?.addedBlocks).toEqual(['## b\none\n\ntwo'])
  })

  test('a client-side block for a server that is not connected is dropped', () => {
    const clients = [other('b', 'pending'), connected('c', 'c')]
    expect(getMcpInstructionsDelta(clients, [], [extra('b', 'x'), extra('nobody', 'y')])?.addedNames).toEqual(['c'])
  })

  test('a client-side block does not re-announce a server already announced', () => {
    expect(getMcpInstructionsDelta([connected('b', 's')], [announced(['b'])], [extra('b', 'late')])).toBeNull()
  })
})
