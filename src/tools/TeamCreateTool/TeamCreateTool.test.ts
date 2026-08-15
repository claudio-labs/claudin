import { afterEach, describe, expect, test } from 'bun:test'

import { TeamCreateTool } from 'src/tools/TeamCreateTool/TeamCreateTool.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
})

describe('TeamCreateTool', () => {
  test('shouldDefer is true and userFacingName is empty', () => {
    expect(TeamCreateTool.shouldDefer).toBe(true)
    expect(TeamCreateTool.userFacingName(undefined)).toBe('')
  })

  test('isEnabled() requires the agent-teams opt-in env or flag', () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    expect(TeamCreateTool.isEnabled?.()).toBe(false)

    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
    expect(TeamCreateTool.isEnabled?.()).toBe(true)
  })

  test('input schema requires team_name and rejects unknown keys', () => {
    expect(TeamCreateTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      TeamCreateTool.inputSchema.safeParse({
        team_name: 'team-a',
        bogus: true,
      }).success,
    ).toBe(false)
    expect(
      TeamCreateTool.inputSchema.safeParse({
        team_name: 'team-a',
        description: 'd',
        agent_type: 'lead',
      }).success,
    ).toBe(true)
  })

  test('toAutoClassifierInput returns the team name', () => {
    expect(
      TeamCreateTool.toAutoClassifierInput?.({
        team_name: 'team-a',
      } as never),
    ).toBe('team-a')
  })

  test('validateInput rejects empty or whitespace-only team_name', async () => {
    const empty = await TeamCreateTool.validateInput?.(
      { team_name: '' } as never,
      {} as never,
    )
    expect(empty?.result).toBe(false)
    if (empty && empty.result === false) {
      expect(empty.errorCode).toBe(9)
    }

    const ws = await TeamCreateTool.validateInput?.(
      { team_name: '   ' } as never,
      {} as never,
    )
    expect(ws?.result).toBe(false)
  })

  test('validateInput accepts a non-empty team_name', async () => {
    const result = await TeamCreateTool.validateInput?.(
      { team_name: 'team-a' } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('mapToolResultToToolResultBlockParam serialises the team data', () => {
    const block = TeamCreateTool.mapToolResultToToolResultBlockParam?.(
      {
        team_name: 'team-a',
        team_file_path: '/tmp/team-a.json',
        lead_agent_id: 'lead:team-a',
      },
      'u1',
    )
    expect(block?.tool_use_id).toBe('u1')
    expect(Array.isArray(block?.content)).toBe(true)
    const text =
      Array.isArray(block?.content) && block.content[0]
        ? (block.content[0] as { text: string }).text
        : ''
    expect(text).toContain('"team-a"')
    expect(text).toContain('"lead:team-a"')
  })
})
