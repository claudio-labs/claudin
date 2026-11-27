/**
 * MCP prompt-argument completion end to end: a real server whose prompt has a
 * completable argument, joined to the v2 Client the way connectToServer joins
 * one (through the wire filter), read by fetchCommandsForClient into the slash
 * command the prompt input completes against.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { completable } from '@modelcontextprotocol/sdk/server/completable.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'

import { connectInMemoryMcpServer } from 'src/mcp/__testutils__/inMemoryMcpServer.js'
import { attachMcpWireFilter, fetchCommandsForClient } from 'src/mcp/client/fetchCapabilities.js'
import type { ConnectedMCPServer, ScopedMcpServerConfig } from 'src/mcp/types.js'
import type { Command } from 'src/shared/types/command.js'

const PEOPLE = ['Alice', 'Alicia', 'Bob', 'Mary Ann']

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

type Seen = { value: string; context?: { arguments?: Record<string, string> } }

async function serveGreet(name: string, seen: Seen[]): Promise<ConnectedMCPServer> {
  const server = new McpServer({ name: `${name}-server`, version: '1.0.0' })
  server.registerPrompt(
    'greet',
    {
      description: 'Greet someone',
      argsSchema: {
        name: completable(z.string().describe('Who to greet'), value => {
          seen.push({ value })
          return PEOPLE.filter(person => person.startsWith(value))
        }),
        greeting: completable(z.string().optional(), (value = '', context) => {
          seen.push({ value, context })
          const who = context?.arguments?.name ?? 'you'
          return [`Hello ${who}`, `Hi ${who}`].filter(line => line.startsWith(value))
        }),
      },
    },
    ({ name: who, greeting }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `${greeting ?? 'Hello'} ${who}` } }],
    }),
  )

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'completions-client', version: '1.0.0' })
  await server.connect(serverTransport)
  attachMcpWireFilter(name, clientTransport)
  await client.connect(clientTransport)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return {
    type: 'connected',
    name,
    client,
    capabilities: client.getServerCapabilities() ?? {},
    config: { type: 'sdk', name, scope: 'local' } as ScopedMcpServerConfig,
    cleanup: async () => {},
  }
}

function promptOf(commands: Command[]) {
  const [command] = commands
  if (command?.type !== 'prompt') throw new Error('expected one prompt command')
  return command
}

describe('MCP prompt argument completion', () => {
  test('a completable prompt carries its argument specs and values', async () => {
    const seen: Seen[] = []
    const greet = promptOf(await fetchCommandsForClient(await serveGreet('complete-greet', seen)))
    expect(greet.argNames).toEqual(['name', 'greeting'])
    expect(greet.argSpecs).toEqual([
      { name: 'name', required: true, description: 'Who to greet' },
      { name: 'greeting', required: false },
    ])
    expect(await greet.argumentValues!('name', 'Ali', {})).toEqual(['Alice', 'Alicia'])
    expect(await greet.argumentValues!('name', 'M', {})).toEqual(['Mary Ann'])
    expect(seen.map(s => s.value)).toEqual(['Ali', 'M'])
  })

  test('the filled arguments reach the server as context', async () => {
    const seen: Seen[] = []
    const greet = promptOf(await fetchCommandsForClient(await serveGreet('complete-context', seen)))
    expect(await greet.argumentValues!('greeting', 'H', { name: 'Mary Ann' })).toEqual([
      'Hello Mary Ann',
      'Hi Mary Ann',
    ])
    expect(seen).toEqual([{ value: 'H', context: { arguments: { name: 'Mary Ann' } } }])
  })

  test('a repeat in the same session does not reach the server again', async () => {
    const seen: Seen[] = []
    const greet = promptOf(await fetchCommandsForClient(await serveGreet('complete-cache', seen)))
    await greet.argumentValues!('name', 'B', {})
    expect(await greet.argumentValues!('name', 'B', {})).toEqual(['Bob'])
    expect(seen).toHaveLength(1)
  })

  test('a server without completions gets the specs for the hint and no values', async () => {
    const { connection, close } = await connectInMemoryMcpServer('complete-none', {
      prompts: [
        {
          name: 'review',
          arguments: [
            { name: 'file', required: true, description: 'The file' },
            { name: 'focus' },
          ],
        },
      ],
    })
    closers.push(close)
    expect(connection.capabilities.completions).toBeUndefined()
    const review = promptOf(await fetchCommandsForClient(connection))
    expect(review.argSpecs).toEqual([
      { name: 'file', required: true, description: 'The file' },
      { name: 'focus', required: false },
    ])
    expect(review.argumentValues).toBeUndefined()
  })

  test('a prompt without arguments carries neither', async () => {
    const { connection, close } = await connectInMemoryMcpServer('complete-bare', {
      prompts: [{ name: 'bare' }],
    })
    closers.push(close)
    const bare = promptOf(await fetchCommandsForClient(connection))
    expect(bare).not.toHaveProperty('argSpecs')
    expect(bare).not.toHaveProperty('argumentValues')
  })
})
