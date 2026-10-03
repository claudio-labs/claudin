/**
 * The pieces of src/mcp/config/ the characterization suite cannot reach
 * through the exports: the walk's stop at the filesystem root, the pure
 * policy verdict, and the atomic writer's cleanup when the rename fails.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compilePolicy, compileUrlPattern, judgeServer, type PolicyLists, type PolicyVerdict } from 'src/mcp/config/policy.js'
import { writeFileAtomically } from 'src/mcp/config/projectFile.js'
import { ancestorChain } from 'src/mcp/config/scopes.js'

describe('ancestorChain', () => {
  test.each([
    ['/a/b/c', ['/a', '/a/b', '/a/b/c']],
    ['/a', ['/a']],
    ['/', []],
  ] as const)('%s, farthest first, without the root', (start, chain) => {
    expect(ancestorChain(start)).toEqual([...chain])
  })
})

describe('judgeServer', () => {
  const stdio = { command: 'node', args: ['s.js'] }
  const remote = { type: 'sse', url: 'https://h.example/sse' }
  const sdk = { type: 'sdk', name: 'in-proc' }
  type Row = [why: string, lists: PolicyLists, config: unknown, verdict: PolicyVerdict]
  const rows: Row[] = [
    ['no lists', { allow: undefined, deny: [] }, stdio, 'allowed'],
    ['a name deny on an sdk server', { allow: undefined, deny: [{ serverName: 'srv' }] }, sdk, 'denied'],
    ['an empty allowlist on an sdk server', { allow: [], deny: [] }, sdk, 'not-allowed'],
    ['an sdk server named on the allowlist', { allow: [{ serverName: 'srv' }, { serverUrl: '*' }], deny: [] }, sdk, 'allowed'],
    ['a deny wins over a matching command allow', { allow: [{ serverCommand: ['node', 's.js'] }], deny: [{ serverCommand: ['node', 's.js'] }] }, stdio, 'denied'],
    ['a URL allow binds a remote server', { allow: [{ serverName: 'srv' }, { serverUrl: 'https://other/*' }], deny: [] }, remote, 'not-allowed'],
    ['something that is not a config is judged by name', { allow: [{ serverName: 'srv' }], deny: [] }, 'garbage', 'allowed'],
  ]

  test.each(rows)('%s', (_why, lists, config, verdict) => {
    expect(judgeServer('srv', config, compilePolicy(lists))).toBe(verdict)
  })
})

describe('compileUrlPattern', () => {
  test.each([
    ['https://*.example.com/*', 'https://a.example.com/x', true],
    ['https://a.example.com', 'https://a.example.com/', false],
    ['https://h/a.b', 'https://h/aXb', false],
    ['*', 'anything at all', true],
    ['HTTPS://H/Path', 'https://h/Path', true],
    ['https://h/Path', 'https://h/path', false],
  ] as const)('%s against %s: %p', (pattern, url, matches) => {
    expect(compileUrlPattern(pattern)(url)).toBe(matches)
  })
})

describe('writeFileAtomically', () => {
  let root = ''

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ''
  })

  test('a failed rename removes the staging file and rethrows', async () => {
    root = mkdtempSync(join(tmpdir(), 'mcp-atomic-'))
    const target = join(root, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep'), 'x')
    await expect(writeFileAtomically(target, '{}')).rejects.toThrow()
    expect(readdirSync(root)).toEqual(['target'])
  })
})
