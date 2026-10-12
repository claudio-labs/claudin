import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  BRIDGE_SAFE_COMMANDS,
  builtInCommandNames,
  clearCommandsCache,
  type Command,
  findCommand,
  formatDescriptionWithSource,
  getCommand,
  getCommands,
  getMcpSkillCommands,
  getSkillToolCommands,
  getSlashCommandToolSkills,
  hasCommand,
  isBridgeSafeCommand,
  meetsAvailabilityRequirement,
} from 'src/commands/commands.js'

function command(fields: { name: string } & Record<string, unknown>): Command {
  return {
    type: 'prompt',
    description: '',
    progressMessage: '',
    contentLength: 0,
    source: 'builtin',
    getPromptForCommand: async () => [],
    ...fields,
  } as Command
}

describe('formatDescriptionWithSource', () => {
  test('returns empty text for prompt commands missing a description', () => {
    const command = {
      name: 'example',
      type: 'prompt',
      source: 'builtin',
      description: undefined,
    } as any

    expect(formatDescriptionWithSource(command)).toBe('')
  })

  test('formats plugin commands with missing description safely', () => {
    const command = {
      name: 'example',
      type: 'prompt',
      source: 'plugin',
      description: undefined,
      pluginInfo: {
        pluginManifest: {
          name: 'MyPlugin',
        },
      },
    } as any

    expect(formatDescriptionWithSource(command)).toBe('(MyPlugin) ')
  })

  test('annotates every other source, and leaves non-prompt commands bare', () => {
    expect(formatDescriptionWithSource(command({ name: 'a', type: 'local', description: 'd' }))).toBe('d')
    expect(formatDescriptionWithSource(command({ name: 'a', description: 'd', kind: 'workflow' }))).toBe('d (workflow)')
    expect(formatDescriptionWithSource(command({ name: 'a', description: 'd', source: 'plugin' }))).toBe('d (plugin)')
    expect(formatDescriptionWithSource(command({ name: 'a', description: 'd', source: 'mcp' }))).toBe('d')
    expect(formatDescriptionWithSource(command({ name: 'a', description: 'd', source: 'bundled' }))).toBe('d (bundled)')
    expect(formatDescriptionWithSource(command({ name: 'a', description: 'd', source: 'projectSettings' }))).toBe('d (project)')
  })
})

describe('builtInCommandNames', () => {
  test('holds the name and every alias of each registered command', () => {
    const names = builtInCommandNames()
    for (const name of ['help', 'review', 'commit', 'provider', 'clear', 'reset', 'exit', 'quit']) {
      expect(names.has(name)).toBe(true)
    }
    expect(names.has('noop')).toBe(false)
  })
})

describe('meetsAvailabilityRequirement', () => {
  test('a command that declares no availability is universal', () => {
    expect(meetsAvailabilityRequirement(command({ name: 'a' }))).toBe(true)
  })

  test('an empty availability list admits nobody', () => {
    expect(meetsAvailabilityRequirement(command({ name: 'a', availability: [] }))).toBe(false)
  })
})

describe('findCommand / hasCommand / getCommand', () => {
  const alpha = command({ name: 'alpha', aliases: ['al'] })
  const beta = command({ name: 'plugin:beta', userFacingName: () => 'beta' })
  const list = [beta, alpha]

  test('matches by name, by alias and by user-facing name', () => {
    expect(findCommand('alpha', list)).toBe(alpha)
    expect(findCommand('al', list)).toBe(alpha)
    expect(findCommand('beta', list)).toBe(beta)
    expect(findCommand('gamma', list)).toBeUndefined()
    expect(hasCommand('al', list)).toBe(true)
    expect(hasCommand('gamma', list)).toBe(false)
  })

  test('getCommand returns the match, or throws naming every command sorted', () => {
    expect(getCommand('alpha', list)).toBe(alpha)
    expect(() => getCommand('gamma', list)).toThrow(
      'Command gamma not found. Available commands: alpha (aliases: al), beta',
    )
  })
})

describe('isBridgeSafeCommand', () => {
  test('prompt commands pass, local-jsx never does, local only from the allowlist', () => {
    expect(isBridgeSafeCommand(command({ name: 'a' }))).toBe(true)
    expect(isBridgeSafeCommand(command({ name: 'a', type: 'local-jsx' }))).toBe(false)
    expect(isBridgeSafeCommand(command({ name: 'a', type: 'local' }))).toBe(false)
    expect(BRIDGE_SAFE_COMMANDS.size).toBeGreaterThan(0)
    for (const safe of BRIDGE_SAFE_COMMANDS) {
      expect(safe.type).toBe('local')
      expect(isBridgeSafeCommand(safe)).toBe(true)
    }
  })
})

describe('getMcpSkillCommands', () => {
  test('is always empty: this fork has no MCP skill discovery', () => {
    expect(getMcpSkillCommands([command({ name: 'a', loadedFrom: 'mcp' })])).toEqual([])
  })
})

describe('getCommands and the model-facing skill lists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commands-test-'))
  afterAll(() => {
    clearCommandsCache()
    rmSync(cwd, { recursive: true, force: true })
  })

  test('returns the enabled built-ins, and only enabled commands', async () => {
    clearCommandsCache()
    const commands = await getCommands(cwd)
    const names = new Set(commands.map(c => c.name))
    for (const name of ['help', 'review', 'commit']) expect(names.has(name)).toBe(true)
    for (const c of commands) expect(c.isEnabled?.() ?? true).toBe(true)
  })

  test('a second call is served from the cache until it is cleared', async () => {
    const first = await getCommands(cwd)
    expect((await getCommands(cwd)).map(c => c.name)).toEqual(first.map(c => c.name))
    clearCommandsCache()
    expect((await getCommands(cwd)).map(c => c.name)).toEqual(first.map(c => c.name))
  })

  test('no built-in prompt command reaches either skill list the model sees', async () => {
    const builtinPrompts = (await getCommands(cwd)).filter(c => c.type === 'prompt' && c.source === 'builtin')
    expect(builtinPrompts.map(c => c.name)).toContain('review')
    for (const list of [await getSkillToolCommands(cwd), await getSlashCommandToolSkills(cwd)]) {
      for (const c of list) expect(c.type === 'prompt' ? c.source : 'not-prompt').not.toBe('builtin')
    }
  })
})
