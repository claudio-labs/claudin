/**
 * Characterization of the MCP config writers (src/mcp/config.ts):
 * `addMcpConfig`, `removeMcpConfig`, `setMcpServerEnabled` and
 * `isMcpServerDisabled`.
 *
 * The project scope writes `.mcp.json` in the cwd; its bytes are pinned
 * against a fixture produced by `addMcpConfig` itself. The user and local
 * scopes write the global config.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { onGlobalConfigChange } from 'src/platform/config/config.js'
import { addMcpConfig, getMcpConfigsByScope, isMcpServerDisabled, removeMcpConfig, setMcpServerEnabled } from 'src/mcp/config.js'
import type { ConfigScope } from 'src/mcp/types.js'
import {
  enterWorld,
  leaveWorld,
  localRecord,
  setLocalServers,
  setToggles,
  setUserServers,
  userServersOnRecord,
  writeManagedMcp,
  writeMcpJson,
  type World,
} from 'src/mcp/__testutils__/mcpConfigWorld.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

let w: World

beforeEach(() => {
  w = enterWorld()
})

afterEach(() => {
  try {
    chmodSync(w.project, 0o755)
  } catch {}
  leaveWorld()
})

const mcpJsonPath = () => join(w.project, '.mcp.json')
const onDisk = () => JSON.parse(readFileSync(mcpJsonPath(), 'utf8'))

describe('addMcpConfig: what is refused before anything is written', () => {
  test.each(['has space', 'dot.name', 'slash/name', 'colon:name', 'ümlaut', 'semi;colon'])('the name %p', async name => {
    await expect(addMcpConfig(name, { command: 'x' }, 'user')).rejects.toThrow(
      `Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`,
    )
  })

  test('letters, digits, hyphens and underscores are fine', async () => {
    await addMcpConfig('Ok_name-2', { command: 'x' }, 'user')
    expect(Object.keys(userServersOnRecord() ?? {})).toEqual(['Ok_name-2'])
  })

  test('a managed MCP file locks every scope, even with a bad config', async () => {
    writeManagedMcp({ mcpServers: {} })
    for (const scope of ['user', 'project', 'local'] as const) {
      await expect(addMcpConfig('x', { nonsense: true }, scope)).rejects.toThrow(
        'Cannot add MCP server: enterprise MCP configuration is active and has exclusive control over MCP servers',
      )
    }
  })

  test.each([
    ['an empty command', { command: '' }, 'Invalid configuration: command: Command cannot be empty'],
    ['a shape no transport accepts', { type: 'sse' }, 'Invalid configuration: '],
    ['not an object', 'node server.js', 'Invalid configuration: '],
  ] as const)('%s', async (_why, config, prefix) => {
    const err = await addMcpConfig('x', config, 'user').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message.startsWith(prefix)).toBe(true)
  })

  test('several issues are joined with a comma', async () => {
    const err = (await addMcpConfig('x', { type: 'http', url: 'u', oauth: { callbackPort: -1, authServerMetadataUrl: 'http://x' } }, 'user').catch(
      (e: Error) => e,
    )) as Error
    expect(err.message).toMatch(/^Invalid configuration: oauth\.\w+: .+, oauth\.\w+: .+$/)
  })

  test.each([
    ['project', 'MCP server dup already exists in .mcp.json'],
    ['user', 'MCP server dup already exists in user config'],
    ['local', 'MCP server dup already exists in local config'],
  ] as const)('a name already in %s', async (scope, message) => {
    writeMcpJson({ mcpServers: { dup: { command: 'old' } } })
    setUserServers({ dup: { command: 'old' } })
    setLocalServers({ dup: { command: 'old' } })
    await expect(addMcpConfig('dup', { command: 'new' }, scope)).rejects.toThrow(message)
  })

  test.each(['dynamic', 'enterprise', 'claudeai', 'managed'] as const)('the %s scope cannot be written', async scope => {
    await expect(addMcpConfig('x', { command: 'c' }, scope)).rejects.toThrow(`Cannot add MCP server to scope: ${scope}`)
  })
})

describe('addMcpConfig: user and local', () => {
  test.each(['user', 'local'] as const)('%s: the validated config is stored next to existing entries', async scope => {
    const set = scope === 'user' ? setUserServers : setLocalServers
    set({ before: { command: 'b', args: [] } })
    await addMcpConfig('added', { type: 'http', url: 'https://h', stray: 1 }, scope)
    await addMcpConfig('plain', { command: 'p' }, scope)
    const stored = scope === 'user' ? userServersOnRecord() : localRecord().mcpServers
    expect(stored).toEqual({
      before: { command: 'b', args: [] },
      added: { type: 'http', url: 'https://h' },
      plain: { command: 'p', args: [] },
    })
  })

  test('nothing lands in .mcp.json', async () => {
    await addMcpConfig('u', { command: 'u' }, 'user')
    await addMcpConfig('l', { command: 'l' }, 'local')
    expect(readdirSync(w.project)).toEqual([])
  })
})

describe('addMcpConfig: project (.mcp.json)', () => {
  test('creates .mcp.json in the cwd, in the fixture format', async () => {
    writeMcpJson({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } })
    await addMcpConfig('tracker', { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } }, 'project')
    expect(readFileSync(mcpJsonPath(), 'utf8')).toBe(readFileSync(join(FIXTURES, 'written.mcp.json'), 'utf8'))
  })

  test('writes only the cwd file, even when an ancestor has one', async () => {
    writeMcpJson({ mcpServers: { up: { command: 'u' } } }, w.outer)
    await addMcpConfig('here', { command: 'h' }, 'project')
    expect(onDisk()).toEqual({ mcpServers: { here: { command: 'h', args: [] } } })
    expect(JSON.parse(readFileSync(join(w.outer, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { up: { command: 'u' } } })
  })

  test('a new file gets 0644 under the umask; an existing mode is kept exactly, umask or not', async () => {
    const previous = process.umask(0o022)
    try {
      await addMcpConfig('a', { command: 'a' }, 'project')
      expect(statSync(mcpJsonPath()).mode & 0o777).toBe(0o644)
      for (const [mode, name] of [[0o600, 'b'], [0o666, 'c']] as const) {
        chmodSync(mcpJsonPath(), mode)
        await addMcpConfig(name, { command: name }, 'project')
        expect(statSync(mcpJsonPath()).mode & 0o777).toBe(mode)
      }
    } finally {
      process.umask(previous)
    }
  })

  test('a symlinked .mcp.json is replaced by a regular file; its target is untouched', async () => {
    const target = join(w.root, 'shared.mcp.json')
    writeFileSync(target, '{"mcpServers":{}}')
    symlinkSync(target, mcpJsonPath())
    await addMcpConfig('a', { command: 'a' }, 'project')
    expect(lstatSync(mcpJsonPath()).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('{"mcpServers":{}}')
    expect(onDisk()).toEqual({ mcpServers: { a: { command: 'a', args: [] } } })
  })

  test('no temporary file is left behind', async () => {
    await addMcpConfig('a', { command: 'a' }, 'project')
    await removeMcpConfig('a', 'project')
    expect(readdirSync(w.project)).toEqual(['.mcp.json'])
  })

  test('a write failure is wrapped, and nothing is stored', async () => {
    if (process.getuid?.() === 0) return
    chmodSync(w.project, 0o555)
    const err = (await addMcpConfig('a', { command: 'a' }, 'project').catch((e: Error) => e)) as Error
    expect(err.message.startsWith('Failed to write to .mcp.json: ')).toBe(true)
    expect(err.message).toContain('EACCES')
    expect(readdirSync(w.project)).toEqual([])
  })
})

describe('removeMcpConfig', () => {
  test('project: removes one entry and keeps the others', async () => {
    writeMcpJson({ mcpServers: { a: { command: 'a' }, b: { type: 'sse', url: 'https://b' } } })
    await removeMcpConfig('a', 'project')
    expect(onDisk()).toEqual({ mcpServers: { b: { type: 'sse', url: 'https://b' } } })
    await removeMcpConfig('b', 'project')
    expect(onDisk()).toEqual({ mcpServers: {} })
  })

  test.each(['user', 'local'] as const)('%s: removes one entry and keeps the others', async scope => {
    const set = scope === 'user' ? setUserServers : setLocalServers
    set({ a: { command: 'a', args: [] }, b: { command: 'b', args: [] } })
    await removeMcpConfig('a', scope)
    expect(Object.keys(getMcpConfigsByScope(scope).servers)).toEqual(['b'])
  })

  // [scope, what the message calls the server, where it says it looked]
  const notThere: Array<[ConfigScope, string, string]> = [
    ['project', 'MCP server', ' in .mcp.json'],
    ['user', 'user-scoped MCP server', ''],
    ['local', 'project-local MCP server', ''],
  ]

  test.each(notThere)('%s: a name that is not there is an error naming the scope', async (scope, label, where) => {
    const err = (await removeMcpConfig('ghost', scope).catch((e: Error) => e)) as Error
    expect(err.message).toBe(`No ${label} found with name: ghost${where}`)
  })

  test.each(['dynamic', 'enterprise', 'claudeai', 'managed'] as const)('the %s scope cannot be removed from', async scope => {
    const err = (await removeMcpConfig('ghost', scope).catch((e: Error) => e)) as Error
    expect(err.message.split(': ')).toEqual(['Cannot remove MCP server from scope', scope])
  })

  test('a broken .mcp.json reads as empty, so nothing can be removed from it', async () => {
    writeMcpJson('{"mcpServers": {"a": ')
    await expect(removeMcpConfig('a', 'project')).rejects.toThrow('No MCP server found with name: a in .mcp.json')
    expect(readFileSync(mcpJsonPath(), 'utf8')).toBe('{"mcpServers": {"a": ')
  })

  test('a managed MCP file does not block removal', async () => {
    setUserServers({ a: { command: 'a', args: [] } })
    writeManagedMcp({ mcpServers: {} })
    await removeMcpConfig('a', 'user')
    expect(userServersOnRecord()).toEqual({})
  })

  test('project: a write failure is wrapped', async () => {
    if (process.getuid?.() === 0) return
    writeMcpJson({ mcpServers: { a: { command: 'a' } } })
    chmodSync(w.project, 0o555)
    const err = (await removeMcpConfig('a', 'project').catch((e: Error) => e)) as Error
    expect(err.message.startsWith('Failed to remove from .mcp.json: ')).toBe(true)
  })
})

describe('enabling and disabling a server', () => {
  test('a server is enabled unless listed as disabled', () => {
    expect(isMcpServerDisabled('srv')).toBe(false)
    setToggles({ disabled: ['srv'] })
    expect([isMcpServerDisabled('srv'), isMcpServerDisabled('other')]).toEqual([true, false])
  })

  test('a claude.ai connector is disabled unless listed as enabled', () => {
    const name = 'claude.ai Gmail'
    expect(isMcpServerDisabled(name)).toBe(true)
    setToggles({ enabled: [name], disabled: [] })
    expect(isMcpServerDisabled(name)).toBe(false)
    setToggles({ enabled: [], disabled: [name] })
    expect(isMcpServerDisabled(name)).toBe(true)
  })

  test('toggling an ordinary server edits the disabled list only', () => {
    setMcpServerEnabled('a', false)
    setMcpServerEnabled('b', false)
    setMcpServerEnabled('a', false)
    expect(localRecord().disabledMcpServers).toEqual(['a', 'b'])
    setMcpServerEnabled('a', true)
    expect(localRecord()).toMatchObject({ disabledMcpServers: ['b'] })
    expect(localRecord().enabledMcpServers ?? []).toEqual([])
    expect([isMcpServerDisabled('a'), isMcpServerDisabled('b')]).toEqual([false, true])
  })

  test('toggling a claude.ai connector edits the enabled list only', () => {
    const name = 'claude.ai Drive'
    setMcpServerEnabled(name, true)
    setMcpServerEnabled(name, true)
    expect(localRecord().enabledMcpServers).toEqual([name])
    expect(isMcpServerDisabled(name)).toBe(false)
    setMcpServerEnabled(name, false)
    expect(localRecord().enabledMcpServers).toEqual([])
    expect(localRecord().disabledMcpServers ?? []).toEqual([])
    expect(isMcpServerDisabled(name)).toBe(true)
  })

  test('a toggle that changes nothing does not write', () => {
    let writes = 0
    const stop = onGlobalConfigChange(() => {
      writes++
    })
    try {
      setMcpServerEnabled('already-on', true)
      setMcpServerEnabled('claude.ai Off', false)
      expect(writes).toBe(0)
      setMcpServerEnabled('already-on', false)
      setMcpServerEnabled('claude.ai Off', true)
      expect(writes).toBe(2)
    } finally {
      stop()
    }
  })
})
