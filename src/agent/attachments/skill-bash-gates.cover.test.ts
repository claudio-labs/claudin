// Characterization net for the skill_listing producer before MCP server skills
// (loadedFrom 'mcp', named `<server>:<skill>`) are fed into it: which commands
// reach the listing, in what order and budget, and the per-agent delta latch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as commandsModule from 'src/commands/commands.js'
import {
  _getSkillLatchSnapshotForTests,
  _seedSentSkillNamesForTests,
  filterToBundledAndMcp,
  getBashGitInstructionsAttachment,
  getSkillListingAttachments,
  resetSentBashGitInstructions,
  resetSentSkillNames,
  suppressNextSkillListing,
} from 'src/agent/attachments/skill-bash-gates.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { enableConfigs } from 'src/platform/config/config.js'
import type { Command } from 'src/shared/types/command.js'
import { addSkillDirectories, clearDynamicSkills, clearSkillCaches } from 'src/skills/loadSkillsDir.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const ENV_KEYS = [
  'NODE_ENV',
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_DISABLE_POLICY_SKILLS',
  'SLASH_COMMAND_TOOL_CHAR_BUDGET',
  'CLAUDIN_BASH_GIT_IN_MESSAGES',
  'CLAUDIN_DISABLE_GIT_INSTRUCTIONS',
  'ANTHROPIC_API_KEY',
  'USER_TYPE',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedProjectRoot = getProjectRoot()
let root: string

function cmd(name: string, loadedFrom: Command['loadedFrom'], fields: Partial<Command> = {}): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} does things`,
    progressMessage: 'running',
    contentLength: 0,
    source: loadedFrom === 'bundled' ? 'bundled' : loadedFrom === 'mcp' ? 'mcp' : 'projectSettings',
    loadedFrom,
    async getPromptForCommand() {
      return []
    },
    ...fields,
  } as Command
}

function ctx(fields: { agentId?: string; tools?: string[]; mcpCommands?: Command[] } = {}): ToolUseContext {
  const tools = (fields.tools ?? [SKILL_TOOL_NAME]).map(name => ({ name }))
  const appState = { mcp: { commands: fields.mcpCommands ?? [], clients: [], tools: [], resources: {} } }
  return {
    agentId: fields.agentId,
    options: { tools, mainLoopModel: 'claude-opus-5-5' },
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

function skill(dir: string, name: string, frontmatter: string): string {
  const skillDir = join(dir, '.claudin', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\nBody of ${name}.\n`)
  return join(dir, '.claudin', 'skills')
}

function resetAll(): void {
  resetSentSkillNames()
  resetSentBashGitInstructions()
  commandsModule.clearCommandMemoizationCaches()
  clearSkillCaches()
  clearDynamicSkills()
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-skill-listing-')))
  mkdirSync(join(root, 'config'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
  // getContextWindowForModel reads the global config, which refuses outside NODE_ENV=test.
  enableConfigs()
  skill(root, 'zz-plain', 'description: a plain zz skill')
  skill(root, 'zz-hidden', 'description: user only\ndisable-model-invocation: true')
})

beforeEach(() => {
  // Leave the NODE_ENV=test early return so the real gates run.
  process.env.NODE_ENV = 'production'
  process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '1000000'
  setProjectRoot(root)
  resetAll()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (key === 'CLAUDIN_CONFIG_DIR' || key === 'CLAUDIN_DISABLE_POLICY_SKILLS') continue
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setProjectRoot(savedProjectRoot)
  resetAll()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setProjectRoot(savedProjectRoot)
  resetAll()
  rmSync(root, { recursive: true, force: true })
})

describe('filterToBundledAndMcp', () => {
  test('keeps only bundled and MCP skills, in their order', () => {
    const input = [cmd('a', 'skills'), cmd('srv:b', 'mcp'), cmd('c', 'bundled'), cmd('d', 'plugin'), cmd('e', undefined)]
    expect(filterToBundledAndMcp(input).map(c => c.name)).toEqual(['srv:b', 'c'])
  })

  test('at 30 it keeps both; past 30 it falls back to bundled only', () => {
    const bundled = [cmd('b1', 'bundled'), cmd('b2', 'bundled')]
    const mcp = (n: number) => Array.from({ length: n }, (_, i) => cmd(`srv:s${i}`, 'mcp'))
    expect(filterToBundledAndMcp([...bundled, ...mcp(28)])).toHaveLength(30)
    expect(filterToBundledAndMcp([...bundled, ...mcp(29)]).map(c => c.name)).toEqual(['b1', 'b2'])
  })
})

describe('getSkillListingAttachments — gates', () => {
  test('under NODE_ENV=test nothing is produced and nothing is marked sent', async () => {
    process.env.NODE_ENV = 'test'
    expect(await getSkillListingAttachments(ctx())).toEqual([])
    expect(_getSkillLatchSnapshotForTests().sentByAgent).toEqual({})
  })

  test('an agent without the Skill tool gets nothing and leaves the latch alone', async () => {
    expect(await getSkillListingAttachments(ctx({ tools: [BASH_TOOL_NAME] }))).toEqual([])
    expect(_getSkillLatchSnapshotForTests().sentByAgent).toEqual({})
  })
})

describe('getSkillListingAttachments — the real command pipeline', () => {
  test('the first call lists every model-invocable skill once; the second sends nothing', async () => {
    const expected = await commandsModule.getSkillToolCommands(root)
    const [first, ...rest] = await getSkillListingAttachments(ctx())
    expect(rest).toEqual([])
    expect(first).toMatchObject({ type: 'skill_listing', isInitial: true, skillCount: expected.length })
    const content = (first as { content: string }).content
    expect(content).toContain('- zz-plain: a plain zz skill')
    expect(content).not.toContain('zz-hidden')
    expect(content.split('\n')).toHaveLength(expected.length)
    expect(_getSkillLatchSnapshotForTests().sentByAgent['']).toEqual(expected.map(c => c.name))

    expect(await getSkillListingAttachments(ctx())).toEqual([])
  })

  test('a skill that appears later is sent alone, as a dynamic delta', async () => {
    await getSkillListingAttachments(ctx())
    const pkg = skill(join(root, 'late'), 'zz-late', 'description: arrived later')
    await addSkillDirectories([pkg])
    commandsModule.clearCommandMemoizationCaches()
    expect(await getSkillListingAttachments(ctx())).toEqual([
      // A nested directory's skill is described with its scope.
      { type: 'skill_listing', content: '- zz-late: (from late/, for files under it) arrived later', skillCount: 1, isInitial: false },
    ])
  })

  test('each agent gets its own initial listing', async () => {
    await getSkillListingAttachments(ctx())
    const [sub] = await getSkillListingAttachments(ctx({ agentId: 'agent-1' }))
    expect(sub).toMatchObject({ type: 'skill_listing', isInitial: true })
    expect(Object.keys(_getSkillLatchSnapshotForTests().sentByAgent).sort()).toEqual(['', 'agent-1'])
  })

  test('after a resume suppress, the current set is marked sent without a listing', async () => {
    suppressNextSkillListing()
    expect(_getSkillLatchSnapshotForTests().suppressNext).toBe(true)
    expect(await getSkillListingAttachments(ctx())).toEqual([])
    const snapshot = _getSkillLatchSnapshotForTests()
    expect(snapshot.suppressNext).toBe(false)
    expect(snapshot.sentByAgent['']).toContain('zz-plain')
    expect(await getSkillListingAttachments(ctx())).toEqual([])
  })

  test('resetSentSkillNames clears the latch and a pending suppress', async () => {
    await getSkillListingAttachments(ctx())
    suppressNextSkillListing()
    resetSentSkillNames()
    expect(_getSkillLatchSnapshotForTests()).toEqual({ suppressNext: false, sentByAgent: {} })
    const [again] = await getSkillListingAttachments(ctx())
    expect(again).toMatchObject({ isInitial: true })
  })

  test('MCP skills in AppState do not reach the listing: getMcpSkillCommands is a stub', async () => {
    const remote = cmd('srv:remote', 'mcp', { hasUserSpecifiedDescription: true })
    expect(commandsModule.getMcpSkillCommands([remote])).toEqual([])
    const [first] = await getSkillListingAttachments(ctx({ mcpCommands: [remote] }))
    expect((first as { content: string }).content).not.toContain('srv:remote')
  })
})

describe('getSkillListingAttachments — merge, order and budget', () => {
  test('local commands come first, MCP ones are appended, a duplicate name keeps the local one', async () => {
    const local = [cmd('alpha', 'skills'), cmd('srv:dup', 'skills', { description: 'local dup' })]
    const remote = [cmd('srv:dup', 'mcp', { description: 'remote dup' }), cmd('srv:zeta', 'mcp')]
    const localSpy = spyOn(commandsModule, 'getSkillToolCommands').mockImplementation((async () => local) as never)
    const mcpSpy = spyOn(commandsModule, 'getMcpSkillCommands').mockImplementation(() => remote)
    try {
      const [listing] = await getSkillListingAttachments(ctx({ mcpCommands: remote }))
      expect(listing).toEqual({
        type: 'skill_listing',
        content: '- alpha: alpha does things\n- srv:dup: local dup\n- srv:zeta: srv:zeta does things',
        skillCount: 3,
        isInitial: true,
      })
      expect(mcpSpy).toHaveBeenCalledWith(remote)
    } finally {
      localSpy.mockRestore()
      mcpSpy.mockRestore()
    }
  })

  test('seeded names are skipped and the rest go out as a non-initial delta', async () => {
    const local = [cmd('alpha', 'skills'), cmd('beta', 'skills')]
    const spy = spyOn(commandsModule, 'getSkillToolCommands').mockImplementation((async () => local) as never)
    try {
      _seedSentSkillNamesForTests('', ['alpha'])
      expect(await getSkillListingAttachments(ctx())).toEqual([
        { type: 'skill_listing', content: '- beta: beta does things', skillCount: 1, isInitial: false },
      ])
      expect(_getSkillLatchSnapshotForTests().sentByAgent['']).toEqual(['alpha', 'beta'])
    } finally {
      spy.mockRestore()
    }
  })

  test('over budget, bundled keep their description and the rest go names-only', async () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '60'
    const local = [cmd('one', 'skills'), cmd('bun', 'bundled'), cmd('srv:two', 'mcp')]
    const spy = spyOn(commandsModule, 'getSkillToolCommands').mockImplementation((async () => local) as never)
    try {
      const [listing] = await getSkillListingAttachments(ctx())
      expect((listing as { content: string }).content).toBe('- one\n- bun: bun does things\n- srv:two')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('getBashGitInstructionsAttachment — remaining gates', () => {
  const bashCtx = (agentId?: string) => ctx({ agentId, tools: [BASH_TOOL_NAME] })

  beforeEach(() => {
    enableConfigs()
    delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'
    delete process.env.USER_TYPE
    if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
  })

  test('NODE_ENV=test, the messages opt-out, no Bash tool and the git opt-out each say no', async () => {
    process.env.NODE_ENV = 'test'
    expect(await getBashGitInstructionsAttachment(bashCtx())).toEqual([])
    process.env.NODE_ENV = 'production'
    process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = '0'
    expect(await getBashGitInstructionsAttachment(bashCtx())).toEqual([])
    delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    expect(await getBashGitInstructionsAttachment(ctx({ tools: [SKILL_TOOL_NAME] }))).toEqual([])
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'true'
    expect(await getBashGitInstructionsAttachment(bashCtx())).toEqual([])
    // None of them spent the agent's one emission.
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'
    expect(await getBashGitInstructionsAttachment(bashCtx())).toHaveLength(1)
  })

  test('sent once per agent; a targeted reset frees only that agent', async () => {
    expect(await getBashGitInstructionsAttachment(bashCtx())).toHaveLength(1)
    expect(await getBashGitInstructionsAttachment(bashCtx('sub'))).toHaveLength(1)
    expect(await getBashGitInstructionsAttachment(bashCtx())).toEqual([])
    resetSentBashGitInstructions('sub')
    expect(await getBashGitInstructionsAttachment(bashCtx())).toEqual([])
    const [again] = await getBashGitInstructionsAttachment(bashCtx('sub'))
    expect(again?.type).toBe('bash_git_instructions')
  })
})
