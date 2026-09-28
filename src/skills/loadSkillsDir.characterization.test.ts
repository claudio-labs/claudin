/**
 * Characterization suite for the skill loader (loadSkillsDir.ts and
 * mcpSkillBuilders.ts), written BEFORE its clean-base rewrite so the new
 * implementation has to pass it unchanged. It pins only the public contract:
 * which files on disk become skills and under what name, the Command each one
 * becomes, which sources load and which policies switch them off, path-scoped
 * skills and their activation, the skill directories discovered under a
 * touched file, the loaded signal, and the caches.
 * docs/tech/rewrite/skills/loadSkillsDir.md is the spec it goes with.
 *
 * Every test runs in a fresh temp tree: CLAUDIN_CONFIG_DIR, the managed
 * directory and the project (a directory with a `.git`, so the upward walk
 * stops there) all live under it, so nothing reads the real ~/.claudin, the
 * machine's managed directory or this repository's own .claudin.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import { getAdditionalDirectoriesForClaudeMd, getAllowedSettingSources, getSessionId, setAdditionalDirectoriesForClaudeMd, setAllowedSettingSources } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { HooksSettings } from 'src/platform/settings/types.js'
import { roughTokenCountEstimation } from 'src/shared/tokenEstimation.js'
import type { Command, CommandBase, PromptCommand } from 'src/shared/types/command.js'
// One line per import: the provenance measure skips an import statement, but
// not the member lines of a multi-line one.
import { activateConditionalSkillsForPaths, addSkillDirectories, clearDynamicSkills, clearSkillCaches, createSkillCommand, discoverSkillDirsForPaths, estimateSkillFrontmatterTokens, getDynamicSkills, getSkillDirCommands, getSkillsPath, type LoadedFrom, onDynamicSkillsLoaded, parseSkillFrontmatterFields } from 'src/skills/loadSkillsDir.js'
import { type MCPSkillBuilders, registerMCPSkillBuilders } from 'src/skills/mcpSkillBuilders.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type Prompt = CommandBase & PromptCommand
type SkillParams = Parameters<typeof createSkillCommand>[0]

const ENV_KEYS = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_DISABLE_POLICY_SKILLS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'XDG_CONFIG_HOME',
] as const
// Every source on, as at startup. Set explicitly rather than trusting the
// snapshot: another file in the same run may have narrowed it.
const ALL_SOURCES: SettingSource[] = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings']
const savedEnv = new Map<string, string | undefined>()
let savedSources: SettingSource[] = []
let savedAdditionalDirs: string[] = []

type World = { root: string; config: string; managed: string; repo: string }
let world: World

function newWorld(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skills-char-')))
  const w = {
    root,
    config: join(root, 'config'),
    managed: join(root, 'managed'),
    repo: join(root, 'repo'),
  }
  mkdirSync(w.config, { recursive: true })
  mkdirSync(w.managed, { recursive: true })
  // A `.git` makes the repo the git root, so the upward walk for project
  // skills stops here instead of reaching /tmp or /.
  mkdirSync(join(w.repo, '.git'), { recursive: true })
  return w
}

const userSkills = () => join(world.config, 'skills')
const userCommands = () => join(world.config, 'commands')
const managedSkills = () => join(world.managed, '.claudin', 'skills')
const managedCommands = () => join(world.managed, '.claudin', 'commands')
const projectSkills = (dir = world.repo) => join(dir, '.claudin', 'skills')
const projectCommands = (dir = world.repo) => join(dir, '.claudin', 'commands')

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const fm = (fields: string, body = 'Body\n') => `---\n${fields}\n---\n${body}`

/** Writes `<skillsDir>/<relDir>/SKILL.md` and returns the skill's directory. */
function skill(skillsDir: string, relDir: string, content = fm(`description: ${relDir}`), fileName = 'SKILL.md'): string {
  const dir = join(skillsDir, ...relDir.split('/'))
  write(join(dir, fileName), content)
  return dir
}

function asPrompt(command: Command | undefined): Prompt {
  if (!command || command.type !== 'prompt') throw new Error('expected a prompt command')
  return command
}

async function load(cwd = world.repo): Promise<Prompt[]> {
  return (await getSkillDirCommands(cwd)).map(asPrompt)
}

const names = (commands: readonly Command[]) => commands.map(c => c.name)
const sortedNames = (commands: readonly Command[]) => names(commands).sort()
const find = (commands: readonly Command[], name: string) => asPrompt(commands.find(c => c.name === name))

function params(overrides: Partial<SkillParams> = {}): SkillParams {
  return {
    skillName: 'probe-skill',
    displayName: undefined,
    description: 'a description',
    hasUserSpecifiedDescription: true,
    markdownContent: 'The body.',
    allowedTools: [],
    argumentHint: undefined,
    argumentNames: [],
    whenToUse: undefined,
    version: undefined,
    model: undefined,
    disableModelInvocation: false,
    userInvocable: true,
    source: 'projectSettings',
    baseDir: undefined,
    loadedFrom: 'skills',
    hooks: undefined,
    executionContext: undefined,
    agent: undefined,
    paths: undefined,
    effort: undefined,
    shell: undefined,
    ...overrides,
  }
}

const noContext = {} as ToolUseContext

async function promptText(command: Command, args = '', context: ToolUseContext = noContext): Promise<string> {
  const blocks = await asPrompt(command).getPromptForCommand(args, context)
  expect(blocks).toHaveLength(1)
  const [block] = blocks as { type: string; text: string }[]
  expect(block!.type).toBe('text')
  return block!.text
}

/** A context whose app state throws: reaching it proves the shell pass ran. */
function trapContext(reads: string[]): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState() {
      reads.push('getAppState')
      throw new Error('char-sentinel: app state was read')
    },
  } as unknown as ToolUseContext
}

function lockSkillsToPlugins(value: unknown): void {
  write(join(world.managed, 'managed-settings.json'), JSON.stringify({ strictPluginOnlyCustomization: value }))
  resetSettingsCache()
}

function withoutSource(source: SettingSource): void {
  setAllowedSettingSources(ALL_SOURCES.filter(s => s !== source))
}

function listen(): { count: () => number; stop: () => void } {
  let calls = 0
  const stop = onDynamicSkillsLoaded(() => {
    calls++
  })
  return { count: () => calls, stop }
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  savedSources = [...getAllowedSettingSources()]
  savedAdditionalDirs = [...getAdditionalDirectoriesForClaudeMd()]
})

beforeEach(() => {
  world = newWorld()
  process.env.CLAUDIN_CONFIG_DIR = world.config
  delete process.env.CLAUDIN_SIMPLE
  delete process.env.CLAUDIN_DISABLE_POLICY_SKILLS
  // The managed directory is platform-fixed (/etc/claude-code on Linux) and
  // memoized; point the memo at this test's tree.
  getManagedFilePath.cache.set(undefined, world.managed)
  setAllowedSettingSources([...ALL_SOURCES])
  setAdditionalDirectoriesForClaudeMd([])
  resetSettingsCache()
  clearSkillCaches()
  clearDynamicSkills()
})

afterEach(() => {
  clearSkillCaches()
  clearDynamicSkills()
  setAllowedSettingSources([...savedSources])
  setAdditionalDirectoriesForClaudeMd([...savedAdditionalDirs])
  getManagedFilePath.cache.delete(undefined)
  getManagedSettingsDropInDir.cache.delete(undefined)
  resetSettingsCache()
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(world.root, { recursive: true, force: true })
})

afterAll(() => {
  clearSkillCaches()
  clearDynamicSkills()
})

describe('getSkillsPath: where each source keeps its skills and commands', () => {
  const both = (source: SettingSource | 'plugin') => [getSkillsPath(source, 'skills'), getSkillsPath(source, 'commands')]

  test('policy settings: under the managed directory', () => {
    const managed = join(getManagedFilePath(), '.claudin')
    expect(both('policySettings')).toEqual([join(managed, 'skills'), join(managed, 'commands')])
  })

  test('user settings: under the config home (CLAUDIN_CONFIG_DIR)', () => {
    expect(both('userSettings')).toEqual([join(world.config, 'skills'), join(world.config, 'commands')])
  })

  test('project settings: a relative .claudin/<dir>, always with a forward slash', () => {
    expect(both('projectSettings')).toEqual(['.claudin/skills', '.claudin/commands'])
  })

  test("plugins: the literal 'plugin'; every other source: empty", () => {
    expect(both('plugin')).toEqual(['plugin', 'plugin'])
    expect([...both('localSettings'), ...both('flagSettings')]).toEqual(['', '', '', ''])
  })
})

describe('parseSkillFrontmatterFields: frontmatter to fields', () => {
  test('an empty frontmatter gets the defaults, and the description comes from the body', () => {
    expect(parseSkillFrontmatterFields({}, '\n# The heading\nmore text', 'some-skill')).toEqual({
      displayName: undefined,
      description: 'The heading',
      hasUserSpecifiedDescription: false,
      allowedTools: [],
      argumentHint: undefined,
      argumentNames: [],
      whenToUse: undefined,
      version: undefined,
      model: undefined,
      disableModelInvocation: false,
      userInvocable: true,
      hooks: undefined,
      executionContext: undefined,
      agent: undefined,
      effort: undefined,
      shell: undefined,
    })
  })

  test("with no description and an empty body the label is the fallback: 'Skill' by default", () => {
    expect(parseSkillFrontmatterFields({}, '', 'x').description).toBe('Skill')
    expect(parseSkillFrontmatterFields({}, '  \n\n', 'x', 'Custom command').description).toBe('Custom command')
  })

  test('a body line longer than 100 characters is cut to 97 plus an ellipsis', () => {
    const long = 'a'.repeat(150)
    expect(parseSkillFrontmatterFields({}, long, 'x').description).toBe(`${'a'.repeat(97)}...`)
  })

  test('every field is read from its frontmatter key', () => {
    const hooks: HooksSettings = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hook' }] }] }
    expect(
      parseSkillFrontmatterFields(
        {
          name: 'Pretty Name',
          description: '  A described skill  ',
          'allowed-tools': 'Read, Grep Bash(git status:*)',
          'argument-hint': '<file> [mode]',
          arguments: 'file mode',
          when_to_use: 'When the file needs a look',
          version: '1.2.3',
          model: 'char-custom-model',
          'disable-model-invocation': true,
          // YAML hands over a real boolean here, whatever the declared type says.
          'user-invocable': false as never,
          hooks,
          context: 'fork',
          agent: 'Explore',
          effort: 'high',
          shell: 'powershell',
        },
        'the body',
        'full-skill',
      ),
    ).toEqual({
      displayName: 'Pretty Name',
      description: 'A described skill',
      hasUserSpecifiedDescription: true,
      allowedTools: ['Read', 'Grep', 'Bash(git status:*)'],
      argumentHint: '<file> [mode]',
      argumentNames: ['file', 'mode'],
      whenToUse: 'When the file needs a look',
      version: '1.2.3',
      model: 'char-custom-model',
      disableModelInvocation: true,
      userInvocable: false,
      hooks,
      executionContext: 'fork',
      agent: 'Explore',
      effort: 'high',
      shell: 'powershell',
    })
  })

  test('list forms: allowed-tools and arguments may be YAML lists; numeric argument names are dropped', () => {
    const fields = parseSkillFrontmatterFields(
      { 'allowed-tools': ['Read', 'Edit'], arguments: ['first', '0', 'second'] },
      'b',
      'x',
    )
    expect(fields.allowedTools).toEqual(['Read', 'Edit'])
    expect(fields.argumentNames).toEqual(['first', 'second'])
  })

  test('scalars are coerced to strings: a numeric description, name and argument hint', () => {
    const fields = parseSkillFrontmatterFields({ description: 42 as never, name: 7 as never, 'argument-hint': 3 as never }, 'b', 'x')
    expect(fields).toMatchObject({ description: '42', hasUserSpecifiedDescription: true, displayName: '7', argumentHint: '3' })
  })

  test('a blank or non-scalar description falls back to the body and does not count as user-specified', () => {
    for (const description of ['   ', ['a', 'b']]) {
      const fields = parseSkillFrontmatterFields({ description: description as never }, 'From the body', 'x')
      expect(fields).toMatchObject({ description: 'From the body', hasUserSpecifiedDescription: false })
    }
  })

  test("model: 'inherit' means no override", () => {
    expect(parseSkillFrontmatterFields({ model: 'inherit' }, 'b', 'x').model).toBeUndefined()
  })

  test("booleans: only true or 'true' count as true", () => {
    for (const [raw, expected] of [
      [true, true],
      ['true', true],
      ['yes', false],
      [false, false],
      ['false', false],
    ] as const) {
      const fields = parseSkillFrontmatterFields(
        { 'disable-model-invocation': raw as never, 'user-invocable': raw as never },
        'b',
        'x',
      )
      expect([raw, fields.disableModelInvocation]).toEqual([raw, expected])
      expect([raw, fields.userInvocable]).toEqual([raw, expected])
    }
  })

  test("context: only 'fork' is kept", () => {
    expect(parseSkillFrontmatterFields({ context: 'fork' }, 'b', 'x').executionContext).toBe('fork')
    expect(parseSkillFrontmatterFields({ context: 'inline' }, 'b', 'x').executionContext).toBeUndefined()
    expect(parseSkillFrontmatterFields({ context: 'elsewhere' as never }, 'b', 'x').executionContext).toBeUndefined()
  })

  test('effort: a level (any case) or an integer; anything else is dropped', () => {
    const effort = (raw: unknown) => parseSkillFrontmatterFields({ effort: raw as never }, 'b', 'x').effort
    expect(effort('high')).toBe('high')
    expect(effort('MAX')).toBe('max')
    expect(effort(12)).toBe(12)
    expect(effort('12')).toBe(12)
    expect(effort('extreme')).toBeUndefined()
  })

  test('shell: bash or powershell, case-insensitive; anything else is dropped', () => {
    const shell = (raw: unknown) => parseSkillFrontmatterFields({ shell: raw as never }, 'b', 'x').shell
    expect(shell(' Bash ')).toBe('bash')
    expect(shell('POWERSHELL')).toBe('powershell')
    expect(shell('zsh')).toBeUndefined()
  })

  test('hooks that fail validation are dropped', () => {
    expect(parseSkillFrontmatterFields({ hooks: { NotAnEvent: [] } as never }, 'b', 'x').hooks).toBeUndefined()
    expect(parseSkillFrontmatterFields({ hooks: { PreToolUse: 'nope' } as never }, 'b', 'x').hooks).toBeUndefined()
  })
})

describe('createSkillCommand: the Command it builds', () => {
  test('maps every field onto a prompt Command', () => {
    const hooks = { PreToolUse: [] }
    const command = createSkillCommand(
      params({
        skillName: 'ns:built',
        displayName: 'Built Skill',
        description: 'desc',
        hasUserSpecifiedDescription: false,
        markdownContent: '12345',
        allowedTools: ['Read'],
        argumentHint: '<x>',
        argumentNames: ['x'],
        whenToUse: 'when',
        version: '9',
        model: 'm',
        disableModelInvocation: true,
        userInvocable: true,
        source: 'userSettings',
        baseDir: '/some/dir',
        loadedFrom: 'skills',
        hooks,
        executionContext: 'inline',
        agent: 'Plan',
        paths: ['src'],
        effort: 'low',
        shell: 'bash',
      }),
    )
    expect(command).toEqual({
      type: 'prompt', name: 'ns:built', description: 'desc', hasUserSpecifiedDescription: false,
      allowedTools: ['Read'], argumentHint: '<x>', argNames: ['x'], whenToUse: 'when', version: '9', model: 'm',
      disableModelInvocation: true, userInvocable: true, isHidden: false, context: 'inline', agent: 'Plan', effort: 'low',
      paths: ['src'], contentLength: 5, progressMessage: 'running', source: 'userSettings', loadedFrom: 'skills',
      hooks, skillRoot: '/some/dir', userFacingName: expect.any(Function), getPromptForCommand: expect.any(Function),
    })
    expect(command.userFacingName!()).toBe('Built Skill')
  })

  test('no argument names means no argNames; the user-facing name falls back to the skill name', () => {
    const command = asPrompt(createSkillCommand(params({ skillName: 'plain', argumentNames: [], displayName: undefined })))
    expect(command.argNames).toBeUndefined()
    expect(command.userFacingName!()).toBe('plain')
    expect(createSkillCommand(params({ skillName: 'plain', displayName: '' })).userFacingName!()).toBe('plain')
  })

  test('a skill the user cannot invoke is hidden', () => {
    expect(createSkillCommand(params({ userInvocable: false }))).toMatchObject({ userInvocable: false, isHidden: true })
    expect(createSkillCommand(params({ userInvocable: true }))).toMatchObject({ userInvocable: true, isHidden: false })
  })

  test('contentLength is the length of the markdown body', () => {
    expect(asPrompt(createSkillCommand(params({ markdownContent: 'x'.repeat(321) }))).contentLength).toBe(321)
  })
})

describe('invoking a skill: the prompt it produces', () => {
  test('with a base directory, the prompt announces it before the body', async () => {
    const command = createSkillCommand(params({ baseDir: '/skills/demo', markdownContent: 'Do the thing.' }))
    expect(await promptText(command)).toBe('Base directory for this skill: /skills/demo\n\nDo the thing.')
  })

  test('without a base directory, the prompt is the body alone', async () => {
    const command = createSkillCommand(params({ baseDir: undefined, markdownContent: 'Do the thing.' }))
    expect(await promptText(command)).toBe('Do the thing.')
  })

  test('arguments fill $ARGUMENTS, $ARGUMENTS[n], $n and the named arguments', async () => {
    const command = createSkillCommand(
      params({
        markdownContent: 'all=$ARGUMENTS first=$ARGUMENTS[0] second=$1 named=$target',
        argumentNames: ['source', 'target'],
      }),
    )
    expect(await promptText(command, 'alpha beta')).toBe('all=alpha beta first=alpha second=beta named=beta')
  })

  test('arguments with no placeholder to fill are appended; empty arguments are not', async () => {
    const command = createSkillCommand(params({ markdownContent: 'No placeholders here.' }))
    expect(await promptText(command, 'extra words')).toBe('No placeholders here.\n\nARGUMENTS: extra words')
    expect(await promptText(command, '')).toBe('No placeholders here.')
  })

  test('${CLAUDIN_SKILL_DIR} becomes the base directory, everywhere it appears', async () => {
    const command = createSkillCommand(
      params({ baseDir: '/skills/demo', markdownContent: 'run ${CLAUDIN_SKILL_DIR}/a.sh and ${CLAUDIN_SKILL_DIR}/b.sh' }),
    )
    expect(await promptText(command)).toBe(
      'Base directory for this skill: /skills/demo\n\nrun /skills/demo/a.sh and /skills/demo/b.sh',
    )
  })

  test('without a base directory ${CLAUDIN_SKILL_DIR} is left as written', async () => {
    const command = createSkillCommand(params({ baseDir: undefined, markdownContent: 'at ${CLAUDIN_SKILL_DIR}' }))
    expect(await promptText(command)).toBe('at ${CLAUDIN_SKILL_DIR}')
  })

  test('${CLAUDIN_SESSION_ID} becomes the current session id, everywhere it appears', async () => {
    const command = createSkillCommand(params({ markdownContent: 'id=${CLAUDIN_SESSION_ID};again=${CLAUDIN_SESSION_ID}' }))
    const id = getSessionId()
    expect(await promptText(command)).toBe(`id=${id};again=${id}`)
  })

  test('a skill from disk runs its embedded shell through the permission check (inline and block forms)', async () => {
    for (const body of ['Status: !`echo char-probe`', 'Block:\n```!\necho char-probe\n```\n']) {
      const reads: string[] = []
      const command = createSkillCommand(params({ loadedFrom: 'skills', markdownContent: body }))
      await expect(asPrompt(command).getPromptForCommand('', trapContext(reads))).rejects.toThrow('char-sentinel')
      expect(reads).toContain('getAppState')
    }
  })

  test('a body with no embedded shell never consults the tool-use context', async () => {
    const reads: string[] = []
    const command = createSkillCommand(params({ loadedFrom: 'skills', markdownContent: 'plain text' }))
    expect(await promptText(command, '', trapContext(reads))).toBe('plain text')
    expect(reads).toEqual([])
  })

  test('an MCP skill never executes embedded shell: the text comes back verbatim', async () => {
    const body = 'Inline !`echo char-probe` and a block:\n```!\necho char-probe\n```\n'
    const reads: string[] = []
    const command = createSkillCommand(params({ loadedFrom: 'mcp', source: 'mcp', markdownContent: body }))
    expect(await promptText(command, '', trapContext(reads))).toBe(body)
    expect(reads).toEqual([])
  })
})

describe('estimateSkillFrontmatterTokens', () => {
  test('estimates the name, description and when-to-use, joined by spaces', () => {
    const whenToUse = 'w'.repeat(400)
    const command = createSkillCommand(params({ skillName: 'est', description: 'd'.repeat(40), whenToUse }))
    expect(estimateSkillFrontmatterTokens(command)).toBe(roughTokenCountEstimation(`est ${'d'.repeat(40)} ${whenToUse}`))
  })

  test('a missing when-to-use is skipped', () => {
    const command = createSkillCommand(params({ skillName: 'est', description: 'd'.repeat(40), whenToUse: undefined }))
    expect(estimateSkillFrontmatterTokens(command)).toBe(roughTokenCountEstimation(`est ${'d'.repeat(40)}`))
  })

  test('the body does not count: it is only loaded when the skill runs', () => {
    const small = createSkillCommand(params({ markdownContent: 'x' }))
    const large = createSkillCommand(params({ markdownContent: 'x'.repeat(20_000) }))
    expect(estimateSkillFrontmatterTokens(large)).toBe(estimateSkillFrontmatterTokens(small))
  })
})

describe('getSkillDirCommands: what a skills directory holds', () => {
  test('nothing on disk means no skills', async () => {
    expect(await load()).toEqual([])
  })

  test('each <name>/SKILL.md is one skill named after its directory, rooted there', async () => {
    const dir = skill(userSkills(), 'alpha')
    const [alpha] = await load()
    expect(alpha).toMatchObject({ name: 'alpha', skillRoot: dir, loadedFrom: 'skills', source: 'userSettings' })
  })

  test('the SKILL.md file name is matched case-insensitively', async () => {
    skill(userSkills(), 'lower', fm('description: lower'), 'skill.md')
    skill(userSkills(), 'mixed', fm('description: mixed'), 'Skill.MD')
    expect(sortedNames(await load())).toEqual(['lower', 'mixed'])
  })

  test('markdown at the root of the skills dir, and other markdown beside a SKILL.md, are not skills', async () => {
    write(join(userSkills(), 'loose.md'), fm('description: loose'))
    write(join(userSkills(), 'SKILL.md'), fm('description: root'))
    const dir = skill(userSkills(), 'real')
    write(join(dir, 'reference.md'), fm('description: reference'))
    write(join(userSkills(), 'no-skill-here', 'notes.md'), 'notes')
    expect(names(await load())).toEqual(['real'])
  })

  test('nested directories are namespaced with colons, and a skill may contain further skills', async () => {
    const commit = skill(userSkills(), 'git/commit')
    const form = skill(userSkills(), 'frontend/react/form')
    skill(userSkills(), 'outer')
    skill(userSkills(), 'outer/inner')
    const skills = await load()
    expect(sortedNames(skills)).toEqual(['frontend:react:form', 'git:commit', 'outer', 'outer:inner'])
    expect(find(skills, 'git:commit').skillRoot).toBe(commit)
    expect(find(skills, 'frontend:react:form').skillRoot).toBe(form)
  })

  test('within one directory the skills come back sorted by path', async () => {
    for (const name of ['mango', 'apple', 'zebra', 'cherry']) skill(userSkills(), name)
    expect(names(await load())).toEqual(['apple', 'cherry', 'mango', 'zebra'])
  })

  test.skipIf(process.platform === 'win32')('a symlinked skill directory is followed, and named and rooted at the link', async () => {
    const real = skill(join(world.root, 'elsewhere'), 'real-skill')
    const nestedReal = skill(join(world.root, 'elsewhere'), 'nested-real')
    mkdirSync(userSkills(), { recursive: true })
    symlinkSync(real, join(userSkills(), 'linked'))
    mkdirSync(join(userSkills(), 'cat'), { recursive: true })
    symlinkSync(nestedReal, join(userSkills(), 'cat', 'deep-link'))
    const skills = await load()
    expect(sortedNames(skills)).toEqual(['cat:deep-link', 'linked'])
    expect(find(skills, 'linked').skillRoot).toBe(join(userSkills(), 'linked'))
  })

  test.skipIf(process.platform === 'win32')('a symlink loop ends the walk without duplicates; dangling links are ignored', async () => {
    const loop = skill(userSkills(), 'loop')
    symlinkSync(loop, join(loop, 'again'))
    symlinkSync(join(world.root, 'missing'), join(userSkills(), 'dangling'))
    symlinkSync(join(world.root, 'missing'), join(loop, 'dangling'))
    expect(names(await load())).toEqual(['loop'])
  })

  test('an entry named SKILL.md that cannot be read as a file is skipped, and the rest still load', async () => {
    mkdirSync(join(userSkills(), 'weird', 'SKILL.md'), { recursive: true })
    skill(userSkills(), 'fine')
    expect(names(await load())).toEqual(['fine'])
  })

  test('a SKILL.md whose frontmatter is not valid YAML still loads, with the defaults', async () => {
    const text = fm('- a list item\nkey: then a mapping', 'Broken but usable\n')
    skill(userSkills(), 'broken', text)
    const [broken] = await load()
    expect(broken).toMatchObject({
      name: 'broken',
      description: 'Broken but usable',
      hasUserSpecifiedDescription: false,
      userInvocable: true,
      contentLength: 'Broken but usable\n'.length,
    })
  })
})

describe('getSkillDirCommands: the Command a SKILL.md becomes', () => {
  test('a SKILL.md without frontmatter gets every default', async () => {
    const text = '# Minimal heading\n\nThe body.\n'
    const dir = skill(userSkills(), 'minimal', text)
    const [minimal] = await load()
    expect(minimal).toEqual({
      type: 'prompt',
      name: 'minimal',
      description: 'Minimal heading',
      hasUserSpecifiedDescription: false,
      allowedTools: [],
      argumentHint: undefined,
      argNames: undefined,
      whenToUse: undefined,
      version: undefined,
      model: undefined,
      disableModelInvocation: false,
      userInvocable: true,
      context: undefined,
      agent: undefined,
      effort: undefined,
      paths: undefined,
      contentLength: text.length,
      isHidden: false,
      progressMessage: 'running',
      userFacingName: expect.any(Function),
      source: 'userSettings',
      loadedFrom: 'skills',
      hooks: undefined,
      skillRoot: dir,
      getPromptForCommand: expect.any(Function),
    })
    expect(minimal!.userFacingName!()).toBe('minimal')
  })

  test('a fully specified SKILL.md carries every field', async () => {
    const dir = skill(
      projectSkills(),
      'full',
      fm(
        [
          'name: Pretty Name',
          'description: "  A described skill  "',
          'allowed-tools: Read, Grep, Bash(git status:*)',
          'argument-hint: <file> [mode]',
          'arguments: file mode',
          'when_to_use: When the file needs a look',
          'version: 1.2.3',
          'model: char-custom-model',
          'disable-model-invocation: true',
          'user-invocable: false',
          'context: fork',
          'agent: Explore',
          'effort: high',
          'shell: bash',
          'hooks:',
          '  PreToolUse:',
          '    - matcher: Bash',
          '      hooks:',
          '        - type: command',
          '          command: echo hook',
        ].join('\n'),
        'Body line\n',
      ),
    )
    const [full] = await load()
    expect(full).toEqual({
      type: 'prompt',
      name: 'full',
      description: 'A described skill',
      hasUserSpecifiedDescription: true,
      allowedTools: ['Read', 'Grep', 'Bash(git status:*)'],
      argumentHint: '<file> [mode]',
      argNames: ['file', 'mode'],
      whenToUse: 'When the file needs a look',
      version: '1.2.3',
      model: 'char-custom-model',
      disableModelInvocation: true,
      userInvocable: false,
      context: 'fork',
      agent: 'Explore',
      effort: 'high',
      paths: undefined,
      contentLength: 'Body line\n'.length,
      isHidden: true,
      progressMessage: 'running',
      userFacingName: expect.any(Function),
      source: 'projectSettings',
      loadedFrom: 'skills',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hook' }] }] },
      skillRoot: dir,
      getPromptForCommand: expect.any(Function),
    })
    expect(full!.userFacingName!()).toBe('Pretty Name')
  })

  test('with no description and an empty body the description is "Skill"', async () => {
    skill(userSkills(), 'empty', fm('version: "1"', ''))
    expect((await load())[0]!.description).toBe('Skill')
  })

  test('invoking a loaded skill announces its directory and fills its variables', async () => {
    const dir = skill(userSkills(), 'runner', fm('arguments: target', 'Go to $target in ${CLAUDIN_SKILL_DIR}\n'))
    const [runner] = await load()
    expect(await promptText(runner!, 'home')).toBe(`Base directory for this skill: ${dir}\n\nGo to home in ${dir}\n`)
  })
})

describe('getSkillDirCommands: sources, order and de-duplication', () => {
  test('each source is tagged: managed, user, project, and --add-dir (which counts as project)', async () => {
    skill(managedSkills(), 'from-managed')
    skill(userSkills(), 'from-user')
    skill(projectSkills(), 'from-project')
    const extra = join(world.root, 'extra')
    skill(projectSkills(extra), 'from-extra')
    setAdditionalDirectoriesForClaudeMd([extra])
    const skills = await load()
    expect(skills.map(s => [s.name, s.source, s.loadedFrom])).toEqual([
      ['from-managed', 'policySettings', 'skills'],
      ['from-user', 'userSettings', 'skills'],
      ['from-project', 'projectSettings', 'skills'],
      ['from-extra', 'projectSettings', 'skills'],
    ])
  })

  test('order: managed, user, project, --add-dir, then legacy commands', async () => {
    write(join(projectCommands(), 'legacy.md'), 'legacy body')
    const extra = join(world.root, 'extra')
    skill(projectSkills(extra), 'a-extra')
    setAdditionalDirectoriesForClaudeMd([extra])
    skill(projectSkills(), 'b-project')
    skill(userSkills(), 'c-user')
    skill(managedSkills(), 'd-managed')
    expect(names(await load())).toEqual(['d-managed', 'c-user', 'b-project', 'a-extra', 'legacy'])
  })

  test('project skills come from the cwd up to the git root, nearest first, and never from above it', async () => {
    const cwd = join(world.repo, 'pkg', 'sub')
    mkdirSync(cwd, { recursive: true })
    skill(projectSkills(cwd), 'in-cwd')
    skill(projectSkills(join(world.repo, 'pkg')), 'in-pkg')
    skill(projectSkills(), 'in-root')
    skill(projectSkills(world.root), 'above-root')
    expect(names(await load(cwd))).toEqual(['in-cwd', 'in-pkg', 'in-root'])
  })

  test('the same name from two different files is kept twice, in source order', async () => {
    skill(userSkills(), 'twin')
    skill(projectSkills(), 'twin')
    const skills = await load()
    expect(skills.map(s => [s.name, s.source])).toEqual([
      ['twin', 'userSettings'],
      ['twin', 'projectSettings'],
    ])
  })

  test('the same file reached twice loads once, as its first source', async () => {
    skill(projectSkills(), 'dup')
    setAdditionalDirectoriesForClaudeMd([world.repo])
    const skills = await load()
    expect(skills.map(s => [s.name, s.source])).toEqual([['dup', 'projectSettings']])
  })

  test.skipIf(process.platform === 'win32')('a symlink to a file already loaded is dropped, even under another name', async () => {
    const shared = skill(userSkills(), 'shared')
    mkdirSync(projectSkills(), { recursive: true })
    symlinkSync(shared, join(projectSkills(), 'shared'))
    mkdirSync(join(projectSkills(), 'alias'), { recursive: true })
    symlinkSync(join(shared, 'SKILL.md'), join(projectSkills(), 'alias', 'SKILL.md'))
    const skills = await load()
    expect(skills.map(s => [s.name, s.source])).toEqual([['shared', 'userSettings']])
  })
})

describe('getSkillDirCommands: settings, policy and switches', () => {
  function populate(): void {
    skill(managedSkills(), 'managed-skill')
    skill(userSkills(), 'user-skill')
    skill(projectSkills(), 'project-skill')
    const extra = join(world.root, 'extra')
    skill(projectSkills(extra), 'extra-skill')
    setAdditionalDirectoriesForClaudeMd([extra])
    write(join(userCommands(), 'user-cmd.md'), 'u')
    write(join(projectCommands(), 'project-cmd.md'), 'p')
    write(join(managedCommands(), 'managed-cmd.md'), 'm')
  }

  test('with everything enabled, every source loads', async () => {
    populate()
    expect(sortedNames(await load())).toEqual([
      'extra-skill',
      'managed-cmd',
      'managed-skill',
      'project-cmd',
      'project-skill',
      'user-cmd',
      'user-skill',
    ])
  })

  test('project settings disabled: no project, --add-dir or project legacy commands', async () => {
    populate()
    withoutSource('projectSettings')
    expect(sortedNames(await load())).toEqual(['managed-cmd', 'managed-skill', 'user-cmd', 'user-skill'])
  })

  test('user settings disabled: no user skills or user legacy commands', async () => {
    populate()
    withoutSource('userSettings')
    expect(sortedNames(await load())).toEqual([
      'extra-skill',
      'managed-cmd',
      'managed-skill',
      'project-cmd',
      'project-skill',
    ])
  })

  test('skills locked to plugins by managed policy: only managed skills load, and no legacy commands at all', async () => {
    for (const lock of [['skills'], true]) {
      clearSkillCaches()
      populate()
      lockSkillsToPlugins(lock)
      expect(names(await load())).toEqual(['managed-skill'])
    }
  })

  test('a lock on other surfaces leaves skills alone', async () => {
    populate()
    lockSkillsToPlugins(['agents', 'hooks'])
    expect(await load()).toHaveLength(7)
  })

  test('CLAUDIN_DISABLE_POLICY_SKILLS drops the managed skills directory only', async () => {
    populate()
    process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
    const loaded = names(await load())
    expect(loaded).not.toContain('managed-skill')
    expect(loaded).toEqual(expect.arrayContaining(['user-skill', 'project-skill', 'extra-skill', 'user-cmd']))
  })

  test('bare mode without --add-dir loads nothing', async () => {
    populate()
    setAdditionalDirectoriesForClaudeMd([])
    process.env.CLAUDIN_SIMPLE = '1'
    expect(await load()).toEqual([])
  })

  test('bare mode with --add-dir loads only those directories, as project skills', async () => {
    populate()
    process.env.CLAUDIN_SIMPLE = '1'
    const skills = await load()
    expect(skills.map(s => [s.name, s.source])).toEqual([['extra-skill', 'projectSettings']])
  })

  test('bare mode still honours disabled project settings and the plugin-only lock', async () => {
    populate()
    process.env.CLAUDIN_SIMPLE = '1'
    withoutSource('projectSettings')
    expect(await load()).toEqual([])
    clearSkillCaches()
    setAllowedSettingSources([...ALL_SOURCES])
    lockSkillsToPlugins(['skills'])
    expect(await load()).toEqual([])
  })
})

describe('getSkillDirCommands: legacy commands directories', () => {
  test('a single .md file is a command named after it, with no skill root', async () => {
    write(join(userCommands(), 'deploy.md'), fm('description: Ship it', 'Deploy body\n'))
    const [deploy] = await load()
    expect(deploy).toMatchObject({
      name: 'deploy',
      description: 'Ship it',
      source: 'userSettings',
      loadedFrom: 'commands_DEPRECATED',
      skillRoot: undefined,
      userInvocable: true,
      isHidden: false,
      paths: undefined,
    })
  })

  test('nested files are namespaced with colons; non-markdown files are ignored', async () => {
    write(join(projectCommands(), 'ops', 'deploy.md'), 'd')
    write(join(projectCommands(), 'ops', 'eu', 'rollback.md'), 'r')
    write(join(projectCommands(), 'ops', 'notes.txt'), 'n')
    const skills = await load()
    expect(sortedNames(skills)).toEqual(['ops:deploy', 'ops:eu:rollback'])
    expect(find(skills, 'ops:deploy').source).toBe('projectSettings')
  })

  test('a directory with a SKILL.md is one command named after it; its other markdown is ignored, its subdirectories are not', async () => {
    const tool = join(projectCommands(), 'tool')
    write(join(tool, 'SKILL.md'), fm('description: The tool'))
    write(join(tool, 'extra.md'), 'ignored')
    write(join(tool, 'sub', 'child.md'), 'kept')
    const skills = await load()
    expect(sortedNames(skills)).toEqual(['tool', 'tool:sub:child'])
    expect(find(skills, 'tool')).toMatchObject({ skillRoot: tool, loadedFrom: 'commands_DEPRECATED' })
    expect(find(skills, 'tool:sub:child').skillRoot).toBeUndefined()
  })

  test('the description falls back to "Custom command", and name: never renames the command', async () => {
    write(join(userCommands(), 'blank.md'), fm('name: Fancy', ''))
    const [blank] = await load()
    expect(blank!.description).toBe('Custom command')
    expect(blank!.userFacingName!()).toBe('blank')
  })

  test('paths: is ignored, so a legacy command is never held back', async () => {
    write(join(userCommands(), 'scoped.md'), fm('paths: src/**'))
    const [scoped] = await load()
    expect(scoped).toMatchObject({ name: 'scoped', paths: undefined })
  })

  test('user-invocable is honoured', async () => {
    write(join(userCommands(), 'hidden.md'), fm('user-invocable: false'))
    expect((await load())[0]).toMatchObject({ userInvocable: false, isHidden: true })
  })

  test('invoking a legacy command: the SKILL.md form announces its directory, the single-file form does not', async () => {
    const tool = join(projectCommands(), 'tool')
    write(join(tool, 'SKILL.md'), 'Tool body')
    write(join(projectCommands(), 'single.md'), 'Single body')
    const skills = await load()
    expect(await promptText(find(skills, 'tool'))).toBe(`Base directory for this skill: ${tool}\n\nTool body`)
    expect(await promptText(find(skills, 'single'))).toBe('Single body')
  })
})

describe('path-scoped skills', () => {
  const scoped = (paths: string, name = 'scoped') => skill(projectSkills(), name, fm(paths))

  test('a skill with paths: is held back from the listing', async () => {
    scoped('paths: src/**')
    skill(projectSkills(), 'always')
    expect(names(await load())).toEqual(['always'])
    expect(getDynamicSkills()).toEqual([])
  })

  test('paths that match everything do not scope the skill', async () => {
    scoped('paths: "**"', 'star')
    scoped('paths: "**/**"', 'star-star')
    expect(sortedNames(await load())).toEqual(['star', 'star-star'])
  })

  test('touching a matching file activates it: listed as dynamic, with its patterns', async () => {
    scoped('paths: src/**, docs/*.md')
    await load()
    expect(activateConditionalSkillsForPaths([join(world.repo, 'README.md')], world.repo)).toEqual([])
    expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'deep', 'a.ts')], world.repo)).toEqual(['scoped'])
    const [active] = getDynamicSkills().map(asPrompt)
    expect(active).toMatchObject({ name: 'scoped', paths: ['src', 'docs/*.md'], source: 'projectSettings', loadedFrom: 'skills' })
  })

  test('activation happens once: a second matching file activates nothing', async () => {
    scoped('paths: src/**')
    await load()
    expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo)).toEqual(['scoped'])
    expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'b.ts')], world.repo)).toEqual([])
    expect(names(getDynamicSkills())).toEqual(['scoped'])
  })

  test('patterns are gitignore-style, relative to the cwd; lists and braces expand', async () => {
    scoped('paths:\n  - "*.md"\n  - lib/*.{ts,tsx}', 'multi')
    scoped('paths: docs/*.md', 'docs-only')
    await load()
    const activate = (rel: string) => activateConditionalSkillsForPaths([join(world.repo, ...rel.split('/'))], world.repo)
    expect(activate('docs/sub/x.md')).toEqual(['multi'])
    expect(activate('lib/deep/x.tsx')).toEqual([])
    expect(activate('docs/x.md')).toEqual(['docs-only'])
    expect(sortedNames(getDynamicSkills())).toEqual(['docs-only', 'multi'])
    expect(asPrompt(getDynamicSkills().find(s => s.name === 'multi')).paths).toEqual(['*.md', 'lib/*.ts', 'lib/*.tsx'])
  })

  test('a relative file path is matched as given', async () => {
    scoped('paths: lib/*.{ts,tsx}')
    await load()
    expect(activateConditionalSkillsForPaths(['lib/x.tsx'], world.repo)).toEqual(['scoped'])
  })

  test('files outside the cwd never activate anything', async () => {
    scoped('paths: "*.ts"')
    await load()
    expect(activateConditionalSkillsForPaths([join(world.root, 'elsewhere', 'a.ts')], world.repo)).toEqual([])
    expect(activateConditionalSkillsForPaths(['../a.ts', ''], world.repo)).toEqual([])
    expect(activateConditionalSkillsForPaths([world.repo], world.repo)).toEqual([])
    expect(getDynamicSkills()).toEqual([])
  })

  test('with nothing held, activation is a no-op', () => {
    expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo)).toEqual([])
  })

  test('the loaded signal fires once per activating call, and only then', async () => {
    scoped('paths: src/**', 'one')
    scoped('paths: src/**', 'two')
    await load()
    const listener = listen()
    try {
      activateConditionalSkillsForPaths([join(world.repo, 'README.md')], world.repo)
      expect(listener.count()).toBe(0)
      expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo).sort()).toEqual(['one', 'two'])
      expect(listener.count()).toBe(1)
    } finally {
      listener.stop()
    }
  })

  test('once activated, a later load for another cwd lists the skill; clearSkillCaches forgets that', async () => {
    skill(userSkills(), 'ts-only', fm('paths: "*.ts"'))
    expect(names(await load())).toEqual([])
    expect(activateConditionalSkillsForPaths([join(world.repo, 'a.ts')], world.repo)).toEqual(['ts-only'])
    const other = join(world.root, 'other')
    mkdirSync(join(other, '.git'), { recursive: true })
    expect(names(await load(other))).toEqual(['ts-only'])
    clearSkillCaches()
    expect(names(await load(other))).toEqual([])
  })

  test('clearSkillCaches drops held skills but keeps the ones already activated', async () => {
    scoped('paths: src/**', 'active')
    scoped('paths: docs/**', 'held')
    await load()
    activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo)
    clearSkillCaches()
    expect(activateConditionalSkillsForPaths([join(world.repo, 'docs', 'a.md')], world.repo)).toEqual([])
    expect(names(getDynamicSkills())).toEqual(['active'])
  })

  test('clearDynamicSkills drops held and activated skills alike', async () => {
    scoped('paths: src/**', 'active')
    scoped('paths: docs/**', 'held')
    await load()
    activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo)
    clearDynamicSkills()
    expect(getDynamicSkills()).toEqual([])
    expect(activateConditionalSkillsForPaths([join(world.repo, 'docs', 'a.md')], world.repo)).toEqual([])
  })
})

describe('discoverSkillDirsForPaths: skill directories under a touched file', () => {
  test('finds .claudin/skills in the file directory and every ancestor below the cwd, deepest first', async () => {
    const deep = join(world.repo, 'a', 'b', 'c')
    mkdirSync(projectSkills(deep), { recursive: true })
    mkdirSync(projectSkills(join(world.repo, 'a')), { recursive: true })
    mkdirSync(projectSkills(), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(deep, 'file.ts')], world.repo)).toEqual([
      projectSkills(deep),
      projectSkills(join(world.repo, 'a')),
    ])
  })

  test('across several files the result is still deepest first', async () => {
    const shallow = join(world.repo, 'x')
    const deep = join(world.repo, 'p', 'q', 'r')
    mkdirSync(projectSkills(shallow), { recursive: true })
    mkdirSync(projectSkills(deep), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(shallow, 'f.ts'), join(deep, 'f.ts')], world.repo)).toEqual([
      projectSkills(deep),
      projectSkills(shallow),
    ])
  })

  test("never returns the cwd's own skills directory, nor anything outside the cwd", async () => {
    mkdirSync(projectSkills(), { recursive: true })
    const sibling = join(`${world.repo}-backup`, 'sub')
    mkdirSync(projectSkills(sibling), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(world.repo, 'top.ts')], world.repo)).toEqual([])
    expect(await discoverSkillDirsForPaths([join(sibling, 'f.ts')], world.repo)).toEqual([])
    expect(await discoverSkillDirsForPaths([join(world.root, 'f.ts')], world.repo)).toEqual([])
  })

  test('a trailing separator on the cwd changes nothing', async () => {
    const pkg = join(world.repo, 'pkg')
    mkdirSync(projectSkills(pkg), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(pkg, 'f.ts')], world.repo + sep)).toEqual([projectSkills(pkg)])
  })

  test('each directory is checked once: a hit is not returned again, and a miss is not retried', async () => {
    const pkg = join(world.repo, 'pkg')
    const later = join(world.repo, 'later')
    mkdirSync(projectSkills(pkg), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(pkg, 'f.ts'), join(later, 'f.ts')], world.repo)).toEqual([projectSkills(pkg)])
    mkdirSync(projectSkills(later), { recursive: true })
    expect(await discoverSkillDirsForPaths([join(pkg, 'g.ts'), join(later, 'g.ts')], world.repo)).toEqual([])
    clearDynamicSkills()
    expect(await discoverSkillDirsForPaths([join(pkg, 'g.ts'), join(later, 'g.ts')], world.repo)).toEqual([
      projectSkills(pkg),
      projectSkills(later),
    ])
  })

  test('a skills directory inside a gitignored directory is skipped, and stays skipped', async () => {
    const repo = join(world.root, 'git-repo')
    mkdirSync(repo, { recursive: true })
    // Keep the user's global git config and global excludes out of it.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.XDG_CONFIG_HOME = join(world.root, 'xdg')
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    write(join(repo, '.gitignore'), 'node_modules/\n')
    const ignored = join(repo, 'node_modules', 'pkg')
    const kept = join(repo, 'pkg')
    mkdirSync(projectSkills(ignored), { recursive: true })
    mkdirSync(projectSkills(kept), { recursive: true })
    const files = [join(ignored, 'index.js'), join(kept, 'index.js')]
    expect(await discoverSkillDirsForPaths(files, repo)).toEqual([projectSkills(kept)])
    expect(await discoverSkillDirsForPaths(files, repo)).toEqual([])
  })
})

describe('addSkillDirectories and getDynamicSkills', () => {
  test('loads each <name>/SKILL.md of the given directories as a project skill', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    const root = skill(dir, 'nested-skill')
    skill(dir, 'group/leaf')
    await addSkillDirectories([dir])
    const dynamic = getDynamicSkills().map(asPrompt)
    expect(sortedNames(dynamic)).toEqual(['group:leaf', 'nested-skill'])
    expect(find(dynamic, 'nested-skill')).toMatchObject({ source: 'projectSettings', loadedFrom: 'skills', skillRoot: root })
  })

  test('on a name clash the first directory given (the deepest) wins', async () => {
    const deep = projectSkills(join(world.repo, 'a', 'b'))
    const shallow = projectSkills(join(world.repo, 'a'))
    const deepSkill = skill(deep, 'same')
    skill(shallow, 'same')
    await addSkillDirectories([deep, shallow])
    expect(getDynamicSkills().map(s => asPrompt(s).skillRoot)).toEqual([deepSkill])
  })

  test('a later call replaces a skill of the same name', async () => {
    const first = projectSkills(join(world.repo, 'first'))
    const second = projectSkills(join(world.repo, 'second'))
    skill(first, 'same')
    const secondSkill = skill(second, 'same')
    await addSkillDirectories([first])
    await addSkillDirectories([second])
    expect(getDynamicSkills().map(s => asPrompt(s).skillRoot)).toEqual([secondSkill])
  })

  test('the loaded signal fires after the skills are visible, even when a directory held none', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    skill(dir, 'visible')
    const seen: string[][] = []
    const stop = onDynamicSkillsLoaded(() => seen.push(names(getDynamicSkills())))
    try {
      await addSkillDirectories([dir])
      await addSkillDirectories([join(world.root, 'does-not-exist')])
      expect(seen).toEqual([['visible'], ['visible']])
    } finally {
      stop()
    }
  })

  test('an empty list loads nothing and signals nothing', async () => {
    const listener = listen()
    try {
      await addSkillDirectories([])
      expect(listener.count()).toBe(0)
    } finally {
      listener.stop()
    }
  })

  test('skipped, with no signal, when project settings are disabled or skills are locked to plugins', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    skill(dir, 'blocked')
    const listener = listen()
    try {
      withoutSource('projectSettings')
      await addSkillDirectories([dir])
      setAllowedSettingSources([...ALL_SOURCES])
      lockSkillsToPlugins(['skills'])
      await addSkillDirectories([dir])
      expect(getDynamicSkills()).toEqual([])
      expect(listener.count()).toBe(0)
    } finally {
      listener.stop()
    }
  })

  test('getDynamicSkills hands out a copy', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    skill(dir, 'kept')
    await addSkillDirectories([dir])
    const copy = getDynamicSkills()
    copy.length = 0
    expect(names(getDynamicSkills())).toEqual(['kept'])
  })

  test('clearDynamicSkills empties the dynamic skills', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    skill(dir, 'gone')
    await addSkillDirectories([dir])
    clearDynamicSkills()
    expect(getDynamicSkills()).toEqual([])
  })

  test('clearSkillCaches leaves the dynamic skills alone', async () => {
    const dir = projectSkills(join(world.repo, 'pkg'))
    skill(dir, 'stays')
    await addSkillDirectories([dir])
    clearSkillCaches()
    expect(names(getDynamicSkills())).toEqual(['stays'])
  })
})

describe('onDynamicSkillsLoaded', () => {
  test('a listener is called on each load until it unsubscribes', async () => {
    const listener = listen()
    const dir = projectSkills(join(world.repo, 'pkg'))
    await addSkillDirectories([dir])
    expect(listener.count()).toBe(1)
    listener.stop()
    await addSkillDirectories([dir])
    expect(listener.count()).toBe(1)
  })

  test('a throwing listener is contained: the others still run and loading still succeeds', async () => {
    const calls: string[] = []
    const stopThrowing = onDynamicSkillsLoaded(() => {
      throw new Error('char listener failure')
    })
    const stopCounting = onDynamicSkillsLoaded(() => calls.push('after'))
    try {
      await addSkillDirectories([projectSkills(join(world.repo, 'pkg'))])
      skill(projectSkills(), 'watched', fm('paths: src/**'))
      await load()
      expect(activateConditionalSkillsForPaths([join(world.repo, 'src', 'a.ts')], world.repo)).toEqual(['watched'])
      expect(calls).toEqual(['after', 'after'])
    } finally {
      stopThrowing()
      stopCounting()
    }
  })
})

describe('the listing cache', () => {
  test('results are memoized per cwd until clearSkillCaches, for skills and legacy commands alike', async () => {
    skill(userSkills(), 'first')
    expect(names(await load())).toEqual(['first'])
    skill(userSkills(), 'second')
    write(join(projectCommands(), 'third.md'), 't')
    expect(names(await load())).toEqual(['first'])
    clearSkillCaches()
    expect(names(await load())).toEqual(['first', 'second', 'third'])
  })

  test('another cwd is loaded on its own', async () => {
    const other = join(world.root, 'other')
    mkdirSync(join(other, '.git'), { recursive: true })
    skill(projectSkills(), 'here')
    skill(projectSkills(other), 'there')
    expect(names(await load())).toEqual(['here'])
    expect(names(await load(other))).toEqual(['there'])
  })
})

describe('mcpSkillBuilders', () => {
  test('registerMCPSkillBuilders takes the two functions MCP discovery needs', () => {
    const pair: MCPSkillBuilders = { createSkillCommand, parseSkillFrontmatterFields }
    expect(registerMCPSkillBuilders(pair)).toBeUndefined()
  })

  test('what MCP discovery builds from them is a skill whose shell never runs', async () => {
    const markdown = 'Remote says: !`echo char-probe`'
    const fields = parseSkillFrontmatterFields({ description: 'remote' }, markdown, 'server:remote')
    const loadedFrom: LoadedFrom = 'mcp'
    const command = createSkillCommand({
      ...fields,
      skillName: 'server:remote',
      markdownContent: markdown,
      source: 'mcp',
      baseDir: undefined,
      loadedFrom,
      paths: undefined,
    })
    expect(command).toMatchObject({ name: 'server:remote', description: 'remote', source: 'mcp', loadedFrom: 'mcp' })
    const reads: string[] = []
    expect(await promptText(command, '', trapContext(reads))).toBe(markdown)
    expect(reads).toEqual([])
  })
})
