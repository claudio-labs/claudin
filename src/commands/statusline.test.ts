import { describe, expect, test } from 'bun:test'
import { prepareForkedCommandContext } from 'src/agent/coordinator/forkedAgent.js'
import { builtInCommandNames } from 'src/commands/commands.js'
import statusline, { buildStatuslineRequest, getStatuslineAllowedTools } from 'src/commands/statusline.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import { getBuiltInAgents } from 'src/tools/AgentTool/builtInAgents.js'
import { STATUSLINE_SETUP_AGENT_TYPE } from 'src/tools/AgentTool/built-in/statuslineSetupAgent.js'

describe('/statusline', () => {
  test('is a registered built-in', () => {
    expect(builtInCommandNames().has('statusline')).toBe(true)
    expect(statusline.source).toBe('builtin')
  })

  test('forks straight into the statusline-setup agent', () => {
    expect(statusline.type).toBe('prompt')
    expect(statusline.context).toBe('fork')
    expect(statusline.agent).toBe(STATUSLINE_SETUP_AGENT_TYPE)
  })

  test('is left out of -p, which cannot show the edit dialog', () => {
    expect(statusline.disableNonInteractive).toBe(true)
  })

  test('pre-approves reading the shell rc files and the config home, nothing wider', () => {
    expect(getStatuslineAllowedTools()).toEqual([
      'Read(~/.zshrc)',
      'Read(~/.bashrc)',
      'Read(~/.bash_profile)',
      'Read(~/.profile)',
      `Read(/${getClaudinConfigHomeDir()}/**)`,
    ])
    expect(statusline.allowedTools).toEqual(getStatuslineAllowedTools())
  })
})

describe('buildStatuslineRequest', () => {
  test('with no arguments asks for the PS1 import, falling back to the default line', () => {
    const text = buildStatuslineRequest('  ', true)
    expect(text).toContain('PS1')
    expect(text).toContain('default line')
  })

  test('passes the user request through, trimmed', () => {
    expect(buildStatuslineRequest('  show the cost  ', true).startsWith('show the cost\n')).toBe(true)
  })

  test('tells the agent whether jq is installed', () => {
    expect(buildStatuslineRequest('x', true)).toEndWith('jq is installed on this machine.')
    expect(buildStatuslineRequest('x', false)).toEndWith('jq is not installed on this machine.')
  })

  test('getPromptForCommand returns that request as one text block', async () => {
    const blocks = await statusline.getPromptForCommand('show the cost')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text.startsWith('show the cost\n\njq is ')).toBe(true)
  })
})

describe('the forked run', () => {
  test('resolves the statusline-setup agent, not the Code fallback, and grants the reads', async () => {
    const context = {
      options: { agentDefinitions: { activeAgents: getBuiltInAgents() } },
      getAppState: () => ({ toolPermissionContext: { alwaysAllowRules: {} } }),
    } as unknown as ToolUseContext
    const prepared = await prepareForkedCommandContext(statusline, 'show the cost', context)
    expect(prepared.baseAgent.agentType).toBe(STATUSLINE_SETUP_AGENT_TYPE)
    expect(prepared.modifiedGetAppState().toolPermissionContext.alwaysAllowRules.command).toEqual(
      getStatuslineAllowedTools(),
    )
    expect(prepared.skillContent.startsWith('show the cost\n')).toBe(true)
  })
})
