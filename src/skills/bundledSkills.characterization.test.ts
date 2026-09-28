/**
 * Characterization suite for the bundled-skill registry (bundledSkills.ts and
 * bundledSkillsRoot.ts), written BEFORE its clean-base rewrite so the new
 * implementation has to pass it unchanged. It pins only the public contract:
 * the Command a definition becomes, the registry's copy semantics, and what
 * the reference-file extraction leaves on disk and in the prompt.
 * docs/tech/rewrite/skills/bundledSkills.md is the spec it goes with.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import {
  type BundledSkillDefinition,
  clearBundledSkills,
  getBundledSkillExtractDir,
  getBundledSkills,
  registerBundledSkill,
} from 'src/skills/bundledSkills.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

// MACRO.VERSION is inlined by the build; under bun test it has to exist.
const globals = globalThis as { MACRO?: { VERSION?: string } }
globals.MACRO ??= { VERSION: '0.0.0-test' }

const context = {} as ToolUseContext
let counter = 0
const uniqueName = (label: string) => `char-${label}-${process.pid}-${Date.now()}-${counter++}`

function definition(overrides: Partial<BundledSkillDefinition> = {}): BundledSkillDefinition {
  return {
    name: uniqueName('skill'),
    description: 'a skill for the characterization suite',
    getPromptForCommand: async () => [{ type: 'text', text: 'the prompt body' }],
    ...overrides,
  }
}

function registered(overrides: Partial<BundledSkillDefinition> = {}) {
  registerBundledSkill(definition(overrides))
  const all = getBundledSkills()
  return all[all.length - 1]!
}

const firstText = (blocks: unknown[]) => (blocks[0] as { type: string; text: string }).text

beforeEach(() => clearBundledSkills())
afterAll(() => {
  clearBundledSkills()
  rmSync(getBundledSkillsRoot(), { recursive: true, force: true })
})

describe('getBundledSkillsRoot', () => {
  test('is stable for the life of the process', () => {
    expect(getBundledSkillsRoot()).toBe(getBundledSkillsRoot())
  })

  test('sits under the per-user temp dir, scoped by version, ending in a 32-hex-digit random segment', () => {
    const root = getBundledSkillsRoot()
    const prefix = join(getClaudeTempDir(), 'bundled-skills') + sep
    expect(root.startsWith(prefix)).toBe(true)
    const [version, nonce, ...rest] = root.slice(prefix.length).split(sep)
    expect(version).toBe(globals.MACRO!.VERSION!)
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(rest).toEqual([])
  })

  test('the extraction dir of a skill is the root joined with its name', () => {
    expect(getBundledSkillExtractDir('some-skill')).toBe(join(getBundledSkillsRoot(), 'some-skill'))
  })
})

describe('registerBundledSkill: the Command a definition becomes', () => {
  test('a minimal definition gets the bundled defaults', () => {
    const def = definition()
    registerBundledSkill(def)
    expect(getBundledSkills()).toEqual([
      {
        type: 'prompt',
        name: def.name,
        description: def.description,
        aliases: undefined,
        hasUserSpecifiedDescription: true,
        allowedTools: [],
        argumentHint: undefined,
        whenToUse: undefined,
        model: undefined,
        disableModelInvocation: false,
        userInvocable: true,
        contentLength: 0,
        source: 'bundled',
        loadedFrom: 'bundled',
        hooks: undefined,
        skillRoot: undefined,
        context: undefined,
        agent: undefined,
        isEnabled: undefined,
        isHidden: false,
        progressMessage: 'running',
        getPromptForCommand: expect.any(Function),
      },
    ])
  })

  test('every optional field is carried over as given', () => {
    const isEnabled = () => true
    const hooks = { PreToolUse: [] }
    const command = registered({
      aliases: ['alias-a'],
      whenToUse: 'when it helps',
      argumentHint: '<target>',
      allowedTools: ['Read', 'Grep'],
      model: 'sonnet',
      disableModelInvocation: true,
      isEnabled,
      hooks,
      context: 'fork',
      agent: 'Explore',
    })
    expect(command).toMatchObject({
      aliases: ['alias-a'],
      whenToUse: 'when it helps',
      argumentHint: '<target>',
      allowedTools: ['Read', 'Grep'],
      model: 'sonnet',
      disableModelInvocation: true,
      hooks,
      context: 'fork',
      agent: 'Explore',
    })
    expect((command as { isEnabled?: unknown }).isEnabled).toBe(isEnabled)
  })

  test('a skill the user cannot invoke is hidden', () => {
    expect(registered({ userInvocable: false })).toMatchObject({ userInvocable: false, isHidden: true })
    expect(registered({ userInvocable: true })).toMatchObject({ userInvocable: true, isHidden: false })
  })

  test('without reference files the prompt is exactly what the definition returns', async () => {
    const blocks = [{ type: 'text' as const, text: 'untouched' }, { type: 'text' as const, text: 'second' }]
    const command = registered({ getPromptForCommand: async () => blocks })
    expect(await command.getPromptForCommand('args', context)).toEqual(blocks)
    expect(registered({ files: {} }).skillRoot).toBeUndefined()
  })

  test('the definition receives the arguments and the context it was called with', async () => {
    const seen: unknown[] = []
    const command = registered({
      getPromptForCommand: async (args, ctx) => {
        seen.push(args, ctx)
        return []
      },
    })
    await command.getPromptForCommand('the args', context)
    expect(seen).toEqual(['the args', context])
  })
})

describe('the registry', () => {
  test('keeps registration order', () => {
    const first = definition()
    const second = definition()
    registerBundledSkill(first)
    registerBundledSkill(second)
    expect(getBundledSkills().map(c => c.name)).toEqual([first.name, second.name])
  })

  test('hands out copies: mutating the returned list leaves the registry alone', () => {
    registerBundledSkill(definition())
    const copy = getBundledSkills()
    copy.length = 0
    expect(getBundledSkills()).toHaveLength(1)
  })

  test('clearBundledSkills empties it', () => {
    registerBundledSkill(definition())
    clearBundledSkills()
    expect(getBundledSkills()).toEqual([])
  })
})

describe('reference files', () => {
  test('are extracted on first use and announced before the prompt', async () => {
    const name = uniqueName('files')
    const command = registered({
      name,
      files: { 'README.md': 'top', 'docs/deep/guide.md': 'nested' },
    })
    const dir = getBundledSkillExtractDir(name)
    expect(command.skillRoot).toBe(dir)
    // Lazy: nothing is written at registration time.
    expect(existsSync(dir)).toBe(false)

    const blocks = await command.getPromptForCommand('', context)
    expect(firstText(blocks)).toBe(`Base directory for this skill: ${dir}\n\nthe prompt body`)
    expect(blocks).toHaveLength(1)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('top')
    expect(readFileSync(join(dir, 'docs', 'deep', 'guide.md'), 'utf8')).toBe('nested')
  })

  test.skipIf(process.platform === 'win32')('are owner-only: files 0600, directories 0700', async () => {
    const name = uniqueName('modes')
    const command = registered({ name, files: { 'a.md': 'a', 'sub/b.md': 'b' } })
    await command.getPromptForCommand('', context)
    const dir = getBundledSkillExtractDir(name)
    expect(statSync(join(dir, 'a.md')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'sub', 'b.md')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'sub')).mode & 0o777).toBe(0o700)
  })

  test('are extracted once, even for concurrent first calls', async () => {
    const name = uniqueName('once')
    let calls = 0
    const command = registered({
      name,
      files: { 'x.md': 'x' },
      getPromptForCommand: async () => {
        calls++
        return [{ type: 'text', text: `call ${calls}` }]
      },
    })
    const [a, b] = await Promise.all([
      command.getPromptForCommand('', context),
      command.getPromptForCommand('', context),
    ])
    const dir = getBundledSkillExtractDir(name)
    for (const blocks of [a, b]) expect(firstText(blocks).startsWith(`Base directory for this skill: ${dir}\n\n`)).toBe(true)
    const third = await command.getPromptForCommand('', context)
    expect(firstText(third)).toBe(`Base directory for this skill: ${dir}\n\ncall 3`)
  })

  test('with reference files the definition still receives the arguments and the context', async () => {
    const seen: unknown[] = []
    const command = registered({
      files: { 'x.md': 'x' },
      getPromptForCommand: async (args, ctx) => {
        seen.push(args, ctx)
        return []
      },
    })
    await command.getPromptForCommand('the args', context)
    expect(seen).toEqual(['the args', context])
  })

  test('a prompt that does not start with text gets the announcement as its own first block', async () => {
    const name = uniqueName('image')
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AA==' } }
    const command = registered({ name, files: { 'x.md': 'x' }, getPromptForCommand: async () => [image] })
    const dir = getBundledSkillExtractDir(name)
    expect(await command.getPromptForCommand('', context)).toEqual([
      { type: 'text', text: `Base directory for this skill: ${dir}\n\n` },
      image,
    ])
  })

  test('an empty prompt becomes the announcement alone', async () => {
    const name = uniqueName('empty')
    const command = registered({ name, files: { 'x.md': 'x' }, getPromptForCommand: async () => [] })
    const dir = getBundledSkillExtractDir(name)
    expect(await command.getPromptForCommand('', context)).toEqual([
      { type: 'text', text: `Base directory for this skill: ${dir}\n\n` },
    ])
  })

  test('a path that climbs out of the skill dir fails the extraction, and the skill still runs unannounced', async () => {
    const outside = join(tmpdir(), `escape-${uniqueName('x')}.md`)
    for (const key of ['../escape.md', 'ok/../../escape.md', outside]) {
      const name = uniqueName('traversal')
      const command = registered({ name, files: { [key]: 'owned' } })
      const blocks = await command.getPromptForCommand('', context)
      expect(firstText(blocks)).toBe('the prompt body')
    }
    expect(existsSync(join(getBundledSkillsRoot(), 'escape.md'))).toBe(false)
    expect(existsSync(outside)).toBe(false)
  })

  test('a file already in place fails the extraction instead of being overwritten', async () => {
    const name = uniqueName('exists')
    const dir = getBundledSkillExtractDir(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.md'), 'planted')
    const command = registered({ name, files: { 'x.md': 'fresh' } })
    expect(firstText(await command.getPromptForCommand('', context))).toBe('the prompt body')
    expect(readFileSync(join(dir, 'x.md'), 'utf8')).toBe('planted')
  })

  test.skipIf(process.platform === 'win32')('a symlink in place is never followed', async () => {
    const name = uniqueName('symlink')
    const dir = getBundledSkillExtractDir(name)
    const victim = join(tmpdir(), `victim-${uniqueName('v')}.txt`)
    writeFileSync(victim, 'original')
    mkdirSync(dir, { recursive: true })
    symlinkSync(victim, join(dir, 'x.md'))
    const command = registered({ name, files: { 'x.md': 'injected' } })
    expect(firstText(await command.getPromptForCommand('', context))).toBe('the prompt body')
    expect(readFileSync(victim, 'utf8')).toBe('original')
    expect(lstatSync(join(dir, 'x.md')).isSymbolicLink()).toBe(true)
    rmSync(victim, { force: true })
    rmSync(dirname(join(dir, 'x.md')), { recursive: true, force: true })
  })
})
