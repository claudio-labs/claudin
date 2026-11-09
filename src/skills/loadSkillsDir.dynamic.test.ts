import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  clearDynamicSkills,
  clearSkillCaches,
  createSkillCommand,
  discoverSkillDirsForPaths,
  estimateSkillFrontmatterTokens,
  getDynamicSkills,
  getRegularCommandName,
  getSkillCommandName,
  getSkillDirCommands,
  getSkillsPath,
  nameScopedSkills,
  onDynamicSkillsLoaded,
  parseSkillFrontmatterFields,
  scopedVariantNote,
  transformSkillFiles,
  type ScopedSkill,
} from 'src/skills/loadSkillsDir.js'

// Characterization net for the dynamic (nested-directory) and conditional
// skill paths before directory-scoped names change them.

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_POLICY_SKILLS'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
let root: string
let configDir: string

function skill(dir: string, name: string, frontmatter = `description: ${name} skill`, body = `# ${name}\n`): string {
  const skillDir = join(dir, '.claudin', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return skillDir
}

function promptNames(commands: Command[]): string[] {
  return commands.map(c => c.name).sort()
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-dyn-skills-')))
  configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  process.env.CLAUDIN_CONFIG_DIR = configDir
  process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearSkillCaches()
  clearDynamicSkills()
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  clearSkillCaches()
  clearDynamicSkills()
})

afterEach(() => {
  clearSkillCaches()
  clearDynamicSkills()
})

describe('small helpers', () => {
  test('getSkillsPath per source', () => {
    expect(getSkillsPath('userSettings', 'skills')).toBe(join(configDir, 'skills'))
    expect(getSkillsPath('projectSettings', 'commands')).toBe('.claudin/commands')
    expect(getSkillsPath('policySettings', 'skills')).toEndWith(join('.claudin', 'skills'))
    expect(getSkillsPath('plugin', 'skills')).toBe('plugin')
    expect(getSkillsPath('localSettings', 'skills')).toBe('')
  })

  test('estimateSkillFrontmatterTokens grows with the listed text', () => {
    const short = { name: 'a', description: 'x' } as Command
    const long = { name: 'a', description: 'x'.repeat(400), whenToUse: 'when' } as Command
    expect(estimateSkillFrontmatterTokens(long)).toBeGreaterThan(estimateSkillFrontmatterTokens(short))
  })

  test('skill and command names carry their directories as colon namespaces', () => {
    expect(getSkillCommandName('/base/git/commit/SKILL.md', '/base')).toBe('git:commit')
    expect(getSkillCommandName('/base/deploy/SKILL.md', '/base/')).toBe('deploy')
    expect(getRegularCommandName('/base/ops/restart.md', '/base')).toBe('ops:restart')
    expect(getRegularCommandName('/base/hello.md', '/base')).toBe('hello')
  })

  test('transformSkillFiles keeps only the SKILL.md of a directory that has one', () => {
    const file = (filePath: string) => ({ filePath, baseDir: '/b', frontmatter: {}, content: '', source: 'projectSettings' as const })
    const out = transformSkillFiles([
      file('/b/one/SKILL.md'),
      file('/b/one/notes.md'),
      file('/b/two/a.md'),
      file('/b/two/b.md'),
      file('/b/three/skill.md'),
      file('/b/three/SKILL.md'),
    ])
    expect(out.map(f => f.filePath)).toEqual(['/b/one/SKILL.md', '/b/two/a.md', '/b/two/b.md', '/b/three/skill.md'])
  })
})

describe('parseSkillFrontmatterFields', () => {
  test('reads every field it knows', () => {
    const parsed = parseSkillFrontmatterFields(
      {
        name: 'Deploy',
        description: 'Ship it',
        'allowed-tools': 'Bash(git:*)',
        'argument-hint': '<env>',
        arguments: ['env'],
        when_to_use: 'on release',
        version: '2',
        model: 'inherit',
        'disable-model-invocation': 'true',
        'user-invocable': 'false',
        context: 'fork',
        agent: 'Code',
        effort: 'high',
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
      },
      '# body',
      'deploy',
    )
    expect(parsed).toMatchObject({
      displayName: 'Deploy',
      description: 'Ship it',
      hasUserSpecifiedDescription: true,
      allowedTools: ['Bash(git:*)'],
      argumentHint: '<env>',
      argumentNames: ['env'],
      whenToUse: 'on release',
      version: '2',
      model: undefined,
      disableModelInvocation: true,
      userInvocable: false,
      executionContext: 'fork',
      agent: 'Code',
      effort: 'high',
    })
    expect(parsed.hooks?.PreToolUse).toHaveLength(1)
  })

  test('falls back on the markdown for a description, and drops invalid effort and hooks', () => {
    const frontmatter = { effort: 'loud', hooks: { PreToolUse: 'nope' } } as unknown as Parameters<typeof parseSkillFrontmatterFields>[0]
    const parsed = parseSkillFrontmatterFields(frontmatter, 'First line of the body', 'x')
    expect(parsed.hasUserSpecifiedDescription).toBe(false)
    expect(parsed.description).toContain('First line of the body')
    expect(parsed.effort).toBeUndefined()
    expect(parsed.hooks).toBeUndefined()
    expect(parsed.userInvocable).toBe(true)
    expect(parsed.executionContext).toBeUndefined()
  })
})

describe('createSkillCommand', () => {
  test("an MCP skill's prompt gets its arguments, never its shell blocks run", async () => {
    const command = createSkillCommand({
      ...parseSkillFrontmatterFields({ description: 'remote' }, '', 'remote'),
      skillName: 'remote',
      markdownContent: 'Deploy $ARGUMENTS from ${CLAUDIN_SKILL_DIR}',
      source: 'mcp',
      baseDir: undefined,
      loadedFrom: 'mcp',
      paths: undefined,
      displayName: undefined,
    })
    expect(command.type).toBe('prompt')
    if (command.type !== 'prompt') return
    const [block] = await command.getPromptForCommand('staging', {} as ToolUseContext)
    expect(block).toEqual({ type: 'text', text: 'Deploy staging from ${CLAUDIN_SKILL_DIR}' })
    expect(command.userFacingName?.()).toBe('remote')
  })

  test('a file skill names its base directory and substitutes it', async () => {
    const command = createSkillCommand({
      ...parseSkillFrontmatterFields({ description: 'local' }, '', 'local'),
      skillName: 'local',
      displayName: 'Local One',
      markdownContent: 'Run ${CLAUDIN_SKILL_DIR}/go.sh',
      source: 'projectSettings',
      baseDir: '/skills/local',
      loadedFrom: 'skills',
      paths: undefined,
    })
    if (command.type !== 'prompt') throw new Error('not a prompt command')
    const context = {
      getAppState: () => ({ toolPermissionContext: { alwaysAllowRules: {} } }),
    } as unknown as ToolUseContext
    const [block] = await command.getPromptForCommand('', context)
    expect(block).toEqual({ type: 'text', text: 'Base directory for this skill: /skills/local\n\nRun /skills/local/go.sh' })
    expect(command.userFacingName?.()).toBe('Local One')
  })
})

describe('getSkillDirCommands', () => {
  test('legacy commands load beside skills; a paths: skill waits for a matching file', async () => {
    const cwd = join(root, 'legacy')
    mkdirSync(join(cwd, '.claudin', 'commands'), { recursive: true })
    writeFileSync(join(cwd, '.claudin', 'commands', 'hello.md'), '---\ndescription: say hi\n---\nHi')
    skill(cwd, 'always')
    skill(cwd, 'reacty', 'description: react things\npaths: "src/ui/**"')
    skill(cwd, 'everywhere', 'description: all\npaths: "**"')

    const loaded = await getSkillDirCommands(cwd)
    expect(promptNames(loaded)).toEqual(['always', 'everywhere', 'hello'])
    expect(loaded.find(c => c.name === 'hello')?.loadedFrom).toBe('commands_DEPRECATED')

    expect(activateConditionalSkillsForPaths([join(cwd, 'README.md'), join(root, 'elsewhere.ts')], cwd)).toEqual([])
    let emitted = 0
    const unsubscribe = onDynamicSkillsLoaded(() => {
      emitted++
    })
    try {
      expect(activateConditionalSkillsForPaths([join(cwd, 'src', 'ui', 'Button.tsx')], cwd)).toEqual(['reacty'])
    } finally {
      unsubscribe()
    }
    expect(emitted).toBe(1)
    expect(promptNames(getDynamicSkills())).toEqual(['reacty'])
    // Activated once: a later load keeps it unconditional.
    clearSkillCaches()
    expect(activateConditionalSkillsForPaths([join(cwd, 'src', 'ui', 'Other.tsx')], cwd)).toEqual([])
  })
})

describe('nested skill directories', () => {
  function repo(name: string): string {
    const cwd = join(root, name)
    mkdirSync(cwd, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd })
    return cwd
  }

  test('discovers .claudin/skills between a touched file and the cwd, deepest first, once', async () => {
    const cwd = repo('discover')
    const web = skill(join(cwd, 'apps', 'web'), 'deploy')
    const appsSkills = skill(join(cwd, 'apps'), 'lint')
    skill(cwd, 'root-only')
    const touched = join(cwd, 'apps', 'web', 'src', 'page.tsx')

    const dirs = await discoverSkillDirsForPaths([touched], cwd)
    expect(dirs).toEqual([join(web, '..'), join(appsSkills, '..')])
    // Hit or miss, a directory is checked once per session.
    expect(await discoverSkillDirsForPaths([touched], cwd)).toEqual([])
    // A file outside the cwd discovers nothing.
    expect(await discoverSkillDirsForPaths([join(root, 'outside', 'x.ts')], cwd)).toEqual([])
  })

  test('skips a skills directory inside a gitignored one', async () => {
    const cwd = repo('ignored')
    writeFileSync(join(cwd, '.gitignore'), 'vendor/\n')
    skill(join(cwd, 'vendor', 'pkg'), 'sneaky')
    const dirs = await discoverSkillDirsForPaths([join(cwd, 'vendor', 'pkg', 'index.js')], cwd)
    expect(dirs).toEqual([])
  })

  test('addSkillDirectories keeps a skill per directory; a shared name is offered qualified by each', async () => {
    const cwd = repo('add')
    skill(join(cwd, 'apps', 'web'), 'deploy', 'description: web deploy')
    skill(join(cwd, 'apps'), 'deploy', 'description: apps deploy')
    skill(join(cwd, 'apps'), 'lint', 'description: apps lint')
    const dirs = await discoverSkillDirsForPaths([join(cwd, 'apps', 'web', 'x.ts')], cwd)

    let emitted = 0
    const unsubscribe = onDynamicSkillsLoaded(() => {
      emitted++
    })
    try {
      await addSkillDirectories(dirs, cwd)
      await addSkillDirectories([], cwd)
    } finally {
      unsubscribe()
    }
    expect(emitted).toBe(1)
    const byName = new Map(getDynamicSkills().map(c => [c.name, c]))
    expect([...byName.keys()].sort()).toEqual(['apps/web:deploy', 'apps:deploy', 'lint'])
    expect(byName.get('apps/web:deploy')?.description).toBe('(apps/web/ variant: for files under apps/web/) web deploy')
    expect(byName.get('lint')?.description).toBe('(from apps/, for files under it) apps lint')

    // Next to a root `deploy`, the bare name stays the root one's.
    const beside = new Map(getDynamicSkills(new Set(['deploy'])).map(c => [c.name, c]))
    expect(beside.get('apps/web:deploy')?.description).toBe(
      '(apps/web/ variant of "deploy": use it for files under apps/web/) web deploy',
    )
    expect(beside.has('deploy')).toBe(false)
  })
})

describe('nameScopedSkills', () => {
  const scoped = (name: string, scope: string): ScopedSkill => ({
    skill: {
      type: 'prompt',
      name,
      description: `${name} things`,
      userFacingName: () => name,
    } as Command,
    scope,
  })

  test('a unique scoped skill keeps its bare name; an unscoped one passes through untouched', () => {
    const unscoped = scoped('reacty', '')
    const [web, root] = nameScopedSkills([scoped('deploy', 'apps/web'), unscoped], new Set())
    expect(web?.name).toBe('deploy')
    expect(web?.description).toBe('(from apps/web/, for files under it) deploy things')
    expect(root).toBe(unscoped.skill)
  })

  test('a collision qualifies it, and the qualified name is what it answers to', () => {
    const [web] = nameScopedSkills([scoped('deploy', 'apps/web')], new Set(['deploy']))
    expect(web?.name).toBe('apps/web:deploy')
    expect(web?.userFacingName?.()).toBe('apps/web:deploy')
  })

  test('a qualified name that is already taken is not offered', () => {
    const named = nameScopedSkills([scoped('deploy', 'web'), scoped('lint', 'web')], new Set(['deploy', 'web:deploy']))
    expect(named.map(c => c.name)).toEqual(['lint'])
  })
})

describe('scopedVariantNote', () => {
  const rootDeploy = { type: 'prompt', name: 'deploy', skillRoot: '/repo/.claudin/skills/deploy' } as Command

  test('finds variants under changed directories no Read discovered, and names them qualified', async () => {
    const cwd = join(root, 'variants')
    mkdirSync(cwd, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd })
    skill(join(cwd, 'apps', 'web'), 'deploy', 'description: web deploy')
    skill(join(cwd, 'tools'), 'deploy', 'description: tools deploy')
    skill(join(cwd, 'apps', 'api'), 'deploy', 'description: api deploy')

    const note = await scopedVariantNote('deploy', rootDeploy, cwd, async () => ['apps/web/src/page.tsx', 'tools/', 'README.md'])
    expect(note).toBe(
      'Directory-scoped variants of the "deploy" skill exist in this repository:\n' +
        '- `apps/web:deploy` — for files under apps/web/\n' +
        '- `tools:deploy` — for files under tools/\n' +
        '"deploy" is the unscoped one; call a variant by its exact name to use it instead.',
    )
    // apps/api had no change and no Read, so it was never looked at.
    expect(note).not.toContain('apps/api')
  })

  test('none, a failing status, or only the skill itself: no note', async () => {
    const cwd = join(root, 'novariants')
    mkdirSync(cwd, { recursive: true })
    expect(await scopedVariantNote('deploy', rootDeploy, cwd, async () => [])).toBeNull()
    const failing = async (): Promise<string[]> => {
      throw new Error('not a git repository')
    }
    expect(await scopedVariantNote('deploy', rootDeploy, cwd, failing)).toBeNull()

    const only = join(root, 'onlyone')
    const dir = skill(join(only, 'apps', 'web'), 'release', 'description: web release')
    const self = { type: 'prompt', name: 'release', skillRoot: dir } as Command
    expect(await scopedVariantNote('release', self, only, async () => ['apps/web/a.ts'])).toBeNull()
  })
})
