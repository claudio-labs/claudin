import { afterEach, describe, expect, test } from 'bun:test'

import type { ToolUseContext } from '../../Tool.js'
import { TeamDeleteTool } from './TeamDeleteTool.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
})

function ctxWithNoTeam(): {
  ctx: ToolUseContext
  state: { teamContext?: undefined; inbox?: { messages: unknown[] } }
} {
  const state = {} as {
    teamContext?: undefined
    inbox?: { messages: unknown[] }
  }
  const ctx = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (
      updater: (prev: typeof state) => typeof state,
    ) => Object.assign(state, updater(state)),
    options: {},
  } as unknown as ToolUseContext
  return { ctx, state }
}

describe('TeamDeleteTool', () => {
  test('shouldDefer is true and userFacingName is empty', () => {
    expect(TeamDeleteTool.shouldDefer).toBe(true)
    expect(TeamDeleteTool.userFacingName(undefined)).toBe('')
  })

  test('isEnabled() requires the agent-teams opt-in env or flag', () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    expect(TeamDeleteTool.isEnabled?.()).toBe(false)

    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect(TeamDeleteTool.isEnabled?.()).toBe(true)
  })

  test('input schema is strict empty object', () => {
    expect(TeamDeleteTool.inputSchema.safeParse({}).success).toBe(true)
    expect(
      TeamDeleteTool.inputSchema.safeParse({ team_name: 'x' }).success,
    ).toBe(false)
  })

  test('call() is a no-op when no team context exists', async () => {
    const { ctx, state } = ctxWithNoTeam()
    const { data } = await TeamDeleteTool.call({} as never, ctx, {} as never, {} as never)
    expect(data.success).toBe(true)
    expect(data.message).toBe('No team name found, nothing to clean up')
    expect(data.team_name).toBeUndefined()
    expect(state.inbox?.messages).toEqual([])
  })

  test('mapToolResultToToolResultBlockParam serialises the payload', () => {
    const block = TeamDeleteTool.mapToolResultToToolResultBlockParam?.(
      { success: true, message: 'done', team_name: 'team-a' },
      'u1',
    )
    expect(block?.tool_use_id).toBe('u1')
    const text =
      Array.isArray(block?.content) && block.content[0]
        ? (block.content[0] as { text: string }).text
        : ''
    expect(text).toContain('"team-a"')
    expect(text).toContain('"done"')
  })
})
