import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { getServerByName } from 'src/mcp/serverLookup.js'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('getServerByName', () => {
  const servers = { github: { command: 'gh' }, files: { command: 'fs' } }

  test('returns the server with that name', () => {
    expect(getServerByName(servers, 'github')).toEqual({ command: 'gh' })
  })

  test('returns undefined for a name the scope does not have', () => {
    expect(getServerByName(servers, 'slack')).toBeUndefined()
  })

  test('returns undefined when the scope has no servers at all', () => {
    expect(getServerByName(undefined, 'github')).toBeUndefined()
  })

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'a name inherited from Object.prototype (%s) is not a server',
    name => {
      expect(getServerByName(servers, name)).toBeUndefined()
    },
  )
})

// A by-name read written as `servers[name]` would bypass the helper; writes
// (`servers[name] = …`) and computed keys are fine.
const BARE_LOOKUP_RE = /(?:[sS]ervers\??\.?\[name\](?!\s*=))/

describe('by-name reads go through getServerByName', () => {
  test.each([
    ['./config.ts', 11],
    ['./doctor.ts', 2],
    ['../platform/headless/handlers/mcp.tsx', 3],
  ])('%s', (path, calls) => {
    const text = source(path)
    expect(text.match(BARE_LOOKUP_RE)?.[0]).toBeUndefined()
    expect(text.split('getServerByName(').length - 1).toBe(calls)
  })
})
