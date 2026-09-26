import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { agentNameProblem } from 'src/tools/AgentTool/agentName.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

const priorTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

afterEach(() => {
  if (priorTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = priorTeams
})

describe('agentNameProblem — a name must resolve to the agent it names', () => {
  test('plain words, digits, dots, dashes and underscores are fine', () => {
    for (const name of ['dev', 'tester', 'infra-2', 'pod_watcher', 'v1.2', 'A', 'x'.repeat(64)]) {
      expect(agentNameProblem(name)).toBeUndefined()
    }
  })

  test('anything SendMessage would read as an address is refused', () => {
    for (const name of ['*', 'dev@team', 'uds:/tmp/x.sock', 'two words', '', '-dev', 'x'.repeat(65), 'a\nb']) {
      expect(agentNameProblem(name)).toContain('name must be')
    }
  })

  test('"main" is the main conversation, in any case', () => {
    expect(agentNameProblem('main')).toContain('reserved')
    expect(agentNameProblem('Main')).toContain('reserved')
  })

  test('an agentId-shaped name would be resolved as that id', () => {
    expect(agentNameProblem('a0123456789abcdef')).toContain('agentId')
    expect(agentNameProblem('areview-0123456789abcdef')).toContain('agentId')
  })
})

describe('Agent validateInput — the name check', () => {
  const context = { getAppState: () => ({}) } as unknown as ToolUseContext

  async function validate(input: Record<string, unknown>) {
    return AgentTool.validateInput!(
      { description: 'd', prompt: 'p', ...input } as never,
      context,
    )
  }

  test('no name, or a good one, passes', async () => {
    expect((await validate({})).result).toBe(true)
    expect((await validate({ name: 'tester' })).result).toBe(true)
  })

  test('a name SendMessage cannot resolve is refused with the reason', async () => {
    const verdict = await validate({ name: 'main' })
    expect(verdict.result).toBe(false)
    if (!verdict.result) expect(verdict.message).toContain('reserved')
  })

  test("a teammate's name is the agent team's business", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect((await validate({ name: 'main', team_name: 'crew' })).result).toBe(true)
  })
})

describe('an inline agent registers its name too', () => {
  // The inline branch of call() needs a live model to reach; pin the wiring,
  // the E2E in docs/tech/agent-messaging exercises it.
  const src = readFileSync(new URL('./AgentTool.tsx', import.meta.url), 'utf8')

  test('right after its foreground task exists, and in the background branch', () => {
    const inline = src.indexOf('foregroundTaskId = registration.taskId;')
    expect(inline).toBeGreaterThan(-1)
    expect(src.slice(inline, inline + 300)).toContain(
      'if (name) registerAgentName(rootSetAppState, name, syncAgentId);',
    )
    expect(src).toContain('if (name) registerAgentName(rootSetAppState, name, asyncAgentId);')
  })
})
