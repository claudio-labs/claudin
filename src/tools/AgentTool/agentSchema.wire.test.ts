import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
// Loaded at module scope, while the session is still non-interactive — the
// order main.tsx's static imports produce, which is what froze the -p schema
// into every interactive session before this was decided per request.
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { clearToolSchemaCache } from 'src/agent/tools/toolSchemaCache.js'
import { getIsNonInteractiveSession, setIsInteractive } from 'src/platform/bootstrap/state.js'
import { toolToAPISchema } from 'src/providers/transport/api.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { getEmptyToolPermissionContext, type Tool, type Tools } from 'src/tools/Tool.js'

const loadedNonInteractive = getIsNonInteractiveSession()
const priorBackgroundOff = process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS
const priorTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  delete process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  clearToolSchemaCache()
})

afterEach(() => {
  clearToolSchemaCache()
})

afterAll(() => {
  setIsInteractive(!loadedNonInteractive)
  restoreEnv('CLAUDIN_DISABLE_BACKGROUND_TASKS', priorBackgroundOff)
  restoreEnv('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', priorTeams)
})

/** The Agent tool's input-schema properties as a request would send them. */
async function wireFields(): Promise<string[]> {
  // The description is not under test and needs the agent registry; the
  // schema is the built tool's own.
  const agentTool = { ...AgentTool, prompt: async () => 'Launch a new agent' } as unknown as Tool
  const built = (await toolToAPISchema(agentTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })) as { input_schema: { properties: Record<string, unknown> } }
  return Object.keys(built.input_schema.properties).sort()
}

describe('Agent tool schema on the wire', () => {
  test('the tool was loaded before the session was marked interactive', () => {
    // The precondition every case below depends on; without it they would
    // pass on a schema that was never frozen at the wrong moment.
    expect(loadedNonInteractive).toBe(true)
  })

  test('the zod schema carries run_in_background and name however early it was built', () => {
    const props = Object.keys(
      (zodToJsonSchema(AgentTool.inputSchema) as { properties: Record<string, unknown> }).properties,
    )
    expect(props).toContain('run_in_background')
    expect(props).toContain('name')
  })

  test('an interactive session is offered run_in_background and name, not the team fields', async () => {
    setIsInteractive(true)
    const fields = await wireFields()
    expect(fields).toContain('run_in_background')
    expect(fields).toContain('name')
    expect(fields).not.toContain('team_name')
    expect(fields).not.toContain('mode')
    expect(fields).not.toContain('cwd')
  })

  test('-p withholds both: nothing drains a background agent there', async () => {
    setIsInteractive(false)
    const fields = await wireFields()
    expect(fields).not.toContain('run_in_background')
    expect(fields).not.toContain('name')
    expect(fields).toContain('prompt')
  })

  test('background tasks off withholds both in an interactive session too', async () => {
    setIsInteractive(true)
    process.env.CLAUDIN_DISABLE_BACKGROUND_TASKS = '1'
    const fields = await wireFields()
    expect(fields).not.toContain('run_in_background')
    expect(fields).not.toContain('name')
  })

  test('an agent team keeps name (teammates are spawned by it) even where background is withheld', async () => {
    setIsInteractive(false)
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    const fields = await wireFields()
    expect(fields).toContain('name')
    expect(fields).toContain('team_name')
    expect(fields).toContain('mode')
    expect(fields).not.toContain('run_in_background')
  })
})
