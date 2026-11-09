import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSkillDirectories, clearDynamicSkills } from 'src/skills/loadSkillsDir.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'

// Drives validateInput, checkPermissions and the inline call path against
// skills loaded the way a session discovers nested ones, so the lookup is the
// real getCommands one.

let root: string

function skill(name: string, frontmatter: string, body = `Do the ${name} thing.`): void {
  const dir = join(root, 'pkg', '.claudin', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
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

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-skilltool-')))
  skill('zz-plain-skill', 'description: a plain skill')
  skill('zz-tooling-skill', 'description: needs tools\nallowed-tools: Bash(make:*)\nmodel: sonnet\neffort: low')
  skill('zz-hidden-skill', 'description: user only\ndisable-model-invocation: true')
  await addSkillDirectories([join(root, 'pkg', '.claudin', 'skills')], root)
})

afterAll(() => {
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
    const result = await SkillTool.call({ skill: 'zz-tooling-skill', args: 'now' }, ctx, undefined as never, {
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: {} }] },
    } as never)
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
    const result = await SkillTool.call({ skill: '/zz-plain-skill' }, ctx, undefined as never, {
      message: { id: 'msg_2', content: [] },
    } as never)
    expect(result.data).toMatchObject({ success: true, commandName: 'zz-plain-skill', allowedTools: undefined })
    expect(result.contextModifier!(ctx)).toBe(ctx)
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
  })

  test('description and classifier input name the skill', async () => {
    expect(await SkillTool.description({ skill: 'deploy' } as never, {} as never)).toBe('Execute skill: deploy')
    expect(SkillTool.toAutoClassifierInput?.({ skill: 'deploy' } as never)).toBe('deploy')
  })
})
