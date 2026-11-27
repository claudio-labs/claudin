// SkillTool over MCP-sourced skills (AppState.mcp.commands, loadedFrom 'mcp'),
// next to a disk skill: which ones it resolves, which name wins a collision,
// how permissions treat them, and what an invocation hands the model.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { Command } from 'src/shared/types/command.js'
import { clearCommandsCache } from 'src/commands/commands.js'
import { clearDynamicSkills, clearSkillCaches, createSkillCommand, parseSkillFrontmatterFields } from 'src/skills/loadSkillsDir.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_POLICY_SKILLS'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedProjectRoot = getProjectRoot()
let root: string

function mcpSkill(name: string, body: string, frontmatter: Record<string, string> = {}): Command {
  return createSkillCommand({
    ...parseSkillFrontmatterFields({ description: `${name} from the server`, ...frontmatter }, body, name),
    skillName: name,
    displayName: undefined,
    markdownContent: body,
    source: 'mcp',
    baseDir: undefined,
    loadedFrom: 'mcp',
    paths: undefined,
  })
}

// A plain MCP prompt: listed under /mcp__srv__p, never a skill.
const MCP_PROMPT: Command = {
  type: 'prompt',
  name: 'mcp__srv__p',
  description: 'a server prompt',
  progressMessage: 'running',
  contentLength: 0,
  source: 'mcp',
  isMcp: true,
  async getPromptForCommand() {
    return [{ type: 'text', text: 'prompt text' }]
  },
}

const MCP_COMMANDS: Command[] = [
  mcpSkill('srv:remote', 'Remote says $ARGUMENTS; !`echo zz-remote`'),
  mcpSkill('srv:granting', 'Needs tools', { 'allowed-tools': 'Bash(make:*)' }),
  mcpSkill('zz-local', 'the server copy'),
  MCP_PROMPT,
]

function context(mcpCommands: Command[] = MCP_COMMANDS): ToolUseContext {
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { commands: mcpCommands, clients: [], tools: [], resources: {} },
  } as unknown as AppState
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    options: { tools: [], mainLoopModel: 'claude-opus-5-5', mcpClients: [], commands: [] },
  } as unknown as ToolUseContext
}

async function call(input: { skill: string; args?: string }, ctx = context()) {
  return runWithCwdOverride(root, () =>
    SkillTool.call(input, ctx, undefined as never, {
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_mcp_1', name: 'Skill', input: {} }] },
    } as never),
  )
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-skilltool-mcp-')))
  mkdirSync(join(root, 'config'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
  const skillDir = join(root, '.claudin', 'skills', 'zz-local')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: the disk copy\n---\nDo the zz-local thing.\n')
  setProjectRoot(root)
  clearCommandsCache()
  clearDynamicSkills()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setProjectRoot(savedProjectRoot)
  clearCommandsCache()
  clearSkillCaches()
  clearDynamicSkills()
  rmSync(root, { recursive: true, force: true })
})

describe('SkillTool resolves MCP skills from AppState', () => {
  const validate = (skill: string, ctx = context()) => SkillTool.validateInput!({ skill }, ctx)

  test('an MCP skill is known by its server-qualified name; a plain MCP prompt is not', async () => {
    expect(await validate('srv:remote')).toEqual({ result: true })
    expect(await validate('/srv:remote')).toEqual({ result: true })
    expect(await validate('mcp__srv__p')).toEqual({ result: false, message: 'Unknown skill: mcp__srv__p', errorCode: 2 })
  })

  test('without MCP skills in AppState the disk skills still resolve', async () => {
    expect(await validate('zz-local', context([MCP_PROMPT]))).toEqual({ result: true })
    expect(await validate('srv:remote', context([MCP_PROMPT]))).toMatchObject({ result: false, errorCode: 2 })
  })

  test('an MCP skill with only safe properties runs without asking; one granting tools asks', async () => {
    expect((await SkillTool.checkPermissions({ skill: 'srv:remote' }, context())).behavior).toBe('allow')
    const granting = await SkillTool.checkPermissions({ skill: 'srv:granting' }, context())
    expect(granting).toMatchObject({ behavior: 'ask', message: 'Execute skill: srv:granting' })
  })
})

describe('SkillTool.call on an MCP skill', () => {
  test('loads the server body with its arguments and leaves the shell block unexecuted', async () => {
    const bash = spyOn(BashTool, 'call')
    try {
      const result = await call({ skill: 'srv:remote', args: 'hello' })
      expect(result.data).toEqual({ success: true, commandName: 'srv:remote', allowedTools: undefined, model: undefined })
      const text = JSON.stringify(result.newMessages)
      expect(text).toContain('Remote says hello; !`echo zz-remote`')
      expect(text).toContain('toolu_mcp_1')
      expect(bash).not.toHaveBeenCalled()
    } finally {
      bash.mockRestore()
    }
  })

  test("an MCP skill's allowed-tools are handed back like a disk skill's", async () => {
    const ctx = context()
    const result = await call({ skill: 'srv:granting' }, ctx)
    expect(result.data).toMatchObject({ success: true, commandName: 'srv:granting', allowedTools: ['Bash(make:*)'] })
    expect(result.contextModifier!(ctx).getAppState().toolPermissionContext.alwaysAllowRules.command).toEqual(['Bash(make:*)'])
  })

  test('a disk skill of the same name wins over the MCP one', async () => {
    const text = JSON.stringify((await call({ skill: 'zz-local' })).newMessages)
    expect(text).toContain('Do the zz-local thing.')
    expect(text).not.toContain('the server copy')
  })
})
