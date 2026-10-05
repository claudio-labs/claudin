/**
 * The two messages every /mcp reconnect path ends with: the verdict on a
 * reconnect result, and the text for a reconnect that threw.
 */
import { describe, expect, test } from 'bun:test'
import type { MCPServerConnection } from 'src/mcp/types.js'
import { handleReconnectError, handleReconnectResult } from 'src/mcp/ui/reconnectHelpers.js'

const outcome = (type: MCPServerConnection['type']) => ({
  client: { name: 'ignored', type, config: { command: 'x', scope: 'user' } } as unknown as MCPServerConnection,
  tools: [],
  commands: [],
})

describe('handleReconnectResult', () => {
  const rows: Array<[MCPServerConnection['type'], string, boolean]> = [
    ['connected', 'Reconnected to github.', true],
    ['needs-auth', "github requires authentication. Use the 'Authenticate' option.", false],
    ['failed', 'Failed to reconnect to github.', false],
    ['pending', 'Unknown result when reconnecting to github.', false],
    ['disabled', 'Unknown result when reconnecting to github.', false],
  ]
  for (const [type, message, success] of rows) {
    test(`a ${type} result`, () => {
      expect(handleReconnectResult(outcome(type), 'github')).toEqual({ message, success })
    })
  }

  test('names the server it was given, not the one in the result', () => {
    const verdicts = ['a b', 'claude.ai Notes', ''].map(name => handleReconnectResult(outcome('connected'), name).message)
    expect(verdicts).toEqual(['Reconnected to a b.', 'Reconnected to claude.ai Notes.', 'Reconnected to .'])
  })
})

describe('handleReconnectError', () => {
  const rows: Array<[string, unknown, string]> = [
    ['an Error gives its message', new Error('socket hang up'), 'Error reconnecting to db: socket hang up'],
    ['an Error subclass too', new TypeError('bad url'), 'Error reconnecting to db: bad url'],
    ['a string is used as is', 'timed out', 'Error reconnecting to db: timed out'],
    ['anything else is stringified', 42, 'Error reconnecting to db: 42'],
    ['including undefined', undefined, 'Error reconnecting to db: undefined'],
    ['and a plain object', { code: 'E' }, 'Error reconnecting to db: [object Object]'],
  ]
  for (const [why, thrown, text] of rows) {
    test(why, () => {
      expect(handleReconnectError(thrown, 'db')).toBe(text)
    })
  }
})
