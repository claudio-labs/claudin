import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCommands } from 'src/commands/commands.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { addSkillDirectories, clearDynamicSkills, clearSkillCaches } from 'src/skills/loadSkillsDir.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'

// Drives validateInput, checkPermissions and the inline call path against
// skills loaded the way a session discovers nested ones, so the lookup is the
// real getCommands one. The config dir, the project root and the cwd are all
// temporary, so neither ~/.claudin's skills nor this checkout's git status
// reach the tests.

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_POLICY_SKILLS'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedProjectRoot = getProjectRoot()
let root: string

function skillAt(dir: string, name: string, frontmatter: string, body = `Do the ${name} thing.`): string {
  const skillDir = join(dir, '.claudin', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
  return join(dir, '.claudin', 'skills')
}

function skill(name: string, frontmatter: string, body?: string): void {
  skillAt(join(root, 'pkg'), name, frontmatter, body)
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
}

function context(permissions: Partial<ToolPermissionContext> = {}): ToolUseContext {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), ...permissions }
  const appState = { toolPermissionContext, mcp: { commands: [], clients: [], tools: [], resources: {} } } as unknown as AppState
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    options: { tools: [], mainLoopModel: 'claude-opus-5-5', mcpClients: [], commands: [] },
  } as unknown as ToolUseContext
}

/** SkillTool.call with `projectRoot` as the project and `cwd` as the working directory. */
async function call(input: { skill: string; args?: string }, opts: { projectRoot?: string; cwd?: string; ctx?: ToolUseContext } = {}) {
  const projectRoot = opts.projectRoot ?? root
  setProjectRoot(projectRoot)
  try {
    return await runWithCwdOverride(opts.cwd ?? projectRoot, () =>
      SkillTool.call(input, opts.ctx ?? context(), undefined as never, {
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: {} }] },
      } as never),
    )
  } finally {
    setProjectRoot(root)
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-skilltool-')))
  mkdirSync(join(root, 'config'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
  setProjectRoot(root)
  clearSkillCaches()
  clearDynamicSkills()
  skill('zz-plain-skill', 'description: a plain skill')
  skill('zz-tooling-skill', 'description: needs tools\nallowed-tools: Bash(make:*)\nmodel: sonnet\neffort: low')
  skill('zz-hidden-skill', 'description: user only\ndisable-model-invocation: true')
  await addSkillDirectories([join(root, 'pkg', '.claudin', 'skills')])
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setProjectRoot(savedProjectRoot)
  clearSkillCaches()
  clearDynamicSkills()
  rmSync(root, { recursive: true, force: true })
})

describe('SkillTool.validateInput', () => {
  const validate = (skill: string) => SkillTool.validateInput!({ skill }, context())

  test('a blank name, an unknown one and a model-disabled one are refused', async () => {
    expect(await validate('   ')).toMatchObject({ result: false, errorCode: 1 })
    expect(await validate('zz-no-such-skill')).toEqual({ result: false, message: 'Unknown skill: zz-no-such-skill', errorCode: 2 })
    expect(await validate('zz-hidden-skill')).toMatchObject({ result: false, errorCode: 4 })
  })

  test('a known skill passes, with or without a leading slash', async () => {
    expect(await validate('zz-plain-skill')).toEqual({ result: true })
    expect(await validate('/zz-plain-skill')).toEqual({ result: true })
  })
})

describe('SkillTool.checkPermissions', () => {
  const rule = (content: string) => ({ localSettings: [`Skill(${content})`] })

  test('a skill with only safe properties runs without asking', async () => {
    const result = await SkillTool.checkPermissions({ skill: 'zz-plain-skill' }, context())
    expect(result.behavior).toBe('allow')
  })

  test('one that grants tools asks, offering the exact and the prefix rule', async () => {
    const result = await SkillTool.checkPermissions({ skill: '/zz-tooling-skill', args: 'x' }, context())
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') return
    expect(result.message).toBe('Execute skill: zz-tooling-skill')
    expect(result.suggestions?.flatMap(s => ('rules' in s ? s.rules.map(r => r.ruleContent) : []))).toEqual([
      'zz-tooling-skill',
      'zz-tooling-skill:*',
    ])
    expect(result.metadata).toBeDefined()
  })

  test('an allow rule, exact or by prefix, lets it run; a deny rule blocks it', async () => {
    const exact = await SkillTool.checkPermissions({ skill: 'zz-tooling-skill' }, context({ alwaysAllowRules: rule('zz-tooling-skill') }))
    expect(exact.behavior).toBe('allow')
    const prefix = await SkillTool.checkPermissions({ skill: 'zz-tooling-skill' }, context({ alwaysAllowRules: rule('/zz-tooling:*') }))
    expect(prefix.behavior).toBe('allow')
    const denied = await SkillTool.checkPermissions({ skill: 'zz-plain-skill' }, context({ alwaysDenyRules: rule('zz-plain-skill') }))
    expect(denied).toMatchObject({ behavior: 'deny', message: 'Skill execution blocked by permission rules' })
  })
})

describe('SkillTool.call — inline', () => {
  test("loads the skill's text into the turn and hands back what it grants", async () => {
    const ctx = context()
    const result = await call({ skill: 'zz-tooling-skill', args: 'now' }, { ctx })
    expect(result.data).toMatchObject({
      success: true,
      commandName: 'zz-tooling-skill',
      allowedTools: ['Bash(make:*)'],
    })
    expect((result.data as { model?: string }).model).toContain('sonnet')
    const text = JSON.stringify(result.newMessages)
    expect(text).toContain('Do the zz-tooling-skill thing.')
    expect(text).toContain('toolu_skill_1')

    const modified = result.contextModifier!(ctx)
    expect(modified.getAppState().toolPermissionContext.alwaysAllowRules.command).toEqual(['Bash(make:*)'])
    expect(modified.getAppState().effortValue).toBe('low')
    expect(modified.options.mainLoopModel).not.toBe('claude-opus-5-5')
  })

  test('a skill that grants nothing leaves the context alone', async () => {
    const ctx = context()
    const result = await call({ skill: '/zz-plain-skill' }, { ctx })
    expect(result.data).toMatchObject({ success: true, commandName: 'zz-plain-skill', allowedTools: undefined })
    expect(result.data).not.toHaveProperty('variantsNote')
    expect(result.contextModifier!(ctx)).toBe(ctx)
  })
})

describe('directory-scoped skills beside a root one', () => {
  /** A repository whose project root has a `deploy` skill, with another under apps/web. */
  function repoWithVariant(name: string, project = ''): { repo: string; projectRoot: string } {
    const repo = join(root, name)
    const projectRoot = join(repo, project)
    mkdirSync(join(projectRoot, 'apps', 'web', 'src'), { recursive: true })
    skillAt(projectRoot, 'deploy', 'description: ship the project')
    skillAt(join(projectRoot, 'apps', 'web'), 'deploy', 'description: ship the web app')
    writeFileSync(join(projectRoot, 'apps', 'web', 'src', 'page.tsx'), 'one')
    git(repo, 'init', '-q')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'init')
    return { repo, projectRoot }
  }

  const VARIANT_LINE = '- `apps/web:deploy` — for files under apps/web/'

  // The wiring in getCommands: without the root's names as `taken`, the
  // nested skill would be named `deploy` and then dropped as a duplicate.
  test('getCommands offers the root skill under its name and the nested one qualified', async () => {
    const { projectRoot } = repoWithVariant('wiring')
    await addSkillDirectories([join(projectRoot, 'apps', 'web', '.claudin', 'skills')])
    const names = (await getCommands(projectRoot)).map(c => c.name)
    expect(names).toContain('deploy')
    expect(names).toContain('apps/web:deploy')
  })

  test('calling the root skill names a variant under a changed directory', async () => {
    const { projectRoot } = repoWithVariant('changed')
    writeFileSync(join(projectRoot, 'apps', 'web', 'src', 'page.tsx'), 'two')
    const result = await call({ skill: 'deploy' }, { projectRoot })
    const note = (result.data as { variantsNote?: string }).variantsNote
    expect(note).toContain(VARIANT_LINE)
    expect(note).toContain('"deploy" is the unscoped one')
  })

  // git status prints paths relative to the repository root, not the cwd.
  test('from a project inside a larger repository', async () => {
    const { projectRoot } = repoWithVariant('monorepo', 'pkg')
    writeFileSync(join(projectRoot, 'apps', 'web', 'src', 'page.tsx'), 'two')
    const result = await call({ skill: 'deploy' }, { projectRoot })
    expect((result.data as { variantsNote?: string }).variantsNote).toContain(VARIANT_LINE)
  })

  // Without -z, a rename reads `R  old -> "new"`, quoted when it has a space.
  test('through a renamed file whose new name has a space', async () => {
    const { repo, projectRoot } = repoWithVariant('renamed')
    writeFileSync(join(repo, 'notes.txt'), 'n')
    git(repo, 'add', 'notes.txt')
    git(repo, 'commit', '-qm', 'notes')
    git(repo, 'mv', 'notes.txt', 'apps/web/release notes.txt')
    const result = await call({ skill: 'deploy' }, { projectRoot })
    expect((result.data as { variantsNote?: string }).variantsNote).toContain(VARIANT_LINE)
  })
})

describe('SkillTool result and labels', () => {
  test('the tool result says how the skill ran', () => {
    expect(SkillTool.mapToolResultToToolResultBlockParam({ success: true, commandName: 'deploy' }, 'u1').content).toBe(
      'Launching skill: deploy',
    )
    expect(
      SkillTool.mapToolResultToToolResultBlockParam(
        { success: true, commandName: 'deploy', status: 'forked', agentId: 'a1', result: 'shipped' },
        'u2',
      ).content,
    ).toBe('Skill "deploy" completed (forked execution).\n\nResult:\nshipped')
    expect(
      SkillTool.mapToolResultToToolResultBlockParam(
        { success: true, commandName: 'nightly', status: 'background', agentId: 'a9' },
        'u4',
      ).content,
    ).toBe(
      'Skill "nightly" launched in the background as agent a9. Its result arrives as a task notification: don\'t wait on it or invoke it again meanwhile.',
    )
    expect(
      SkillTool.mapToolResultToToolResultBlockParam(
        { success: true, commandName: 'deploy', variantsNote: 'Directory-scoped variants of the "deploy" skill …' },
        'u3',
      ).content,
    ).toBe('Launching skill: deploy\n\nDirectory-scoped variants of the "deploy" skill …')
  })

  test('description and classifier input name the skill', async () => {
    expect(await SkillTool.description({ skill: 'deploy' } as never, {} as never)).toBe('Execute skill: deploy')
    expect(SkillTool.toAutoClassifierInput?.({ skill: 'deploy' } as never)).toBe('deploy')
  })
})
