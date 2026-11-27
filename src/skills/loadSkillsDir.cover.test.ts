// The inline-shell rule in createSkillCommand.getPromptForCommand, pinned on a
// body that HAS shell blocks: a file skill runs them (through the permission
// check, with its allowed-tools granted), an MCP skill keeps them as text.
// MCP server skills are remote and untrusted, so this is the guard that keeps a
// server's SKILL.md from running commands on the user's machine.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { createSkillCommand, parseSkillFrontmatterFields } from 'src/skills/loadSkillsDir.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

const BODY = 'Inline: !`echo zz-inline`\n\n```!\necho zz-block\n```\nArgs: $ARGUMENTS'

function skillCommand(loadedFrom: 'mcp' | 'skills', allowedTools: string[]) {
  const command = createSkillCommand({
    ...parseSkillFrontmatterFields({ description: 'shelly' }, '', 'shelly'),
    allowedTools,
    skillName: loadedFrom === 'mcp' ? 'srv:shelly' : 'shelly',
    displayName: undefined,
    markdownContent: BODY,
    source: loadedFrom === 'mcp' ? 'mcp' : 'projectSettings',
    baseDir: undefined,
    loadedFrom,
    paths: undefined,
  })
  if (command.type !== 'prompt') throw new Error('not a prompt command')
  return command
}

const seenAllowRules: unknown[] = []

function context(): ToolUseContext {
  const appState = { toolPermissionContext: getEmptyToolPermissionContext(), mcp: { tools: [], clients: [] } }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    options: { tools: [BashTool], mainLoopModel: 'claude-opus-5-5', mcpClients: [], commands: [] },
  } as unknown as ToolUseContext
}

function fakeBash() {
  return spyOn(BashTool, 'call').mockImplementation((async (input: { command: string }, ctx: ToolUseContext) => {
    seenAllowRules.push(ctx.getAppState().toolPermissionContext.alwaysAllowRules.command)
    return { data: { stdout: `ran(${input.command})`, stderr: '', interrupted: false } }
  }) as never)
}

afterEach(() => {
  seenAllowRules.length = 0
})

describe('createSkillCommand — inline shell', () => {
  test('an MCP skill keeps every shell block as literal text and never reaches the shell', async () => {
    const bash = fakeBash()
    try {
      const [block] = await skillCommand('mcp', ['Bash(echo:*)']).getPromptForCommand('go', context())
      expect(block).toEqual({ type: 'text', text: BODY.replace('$ARGUMENTS', 'go') })
      expect(bash).not.toHaveBeenCalled()
    } finally {
      bash.mockRestore()
    }
  })

  test('a file skill runs both forms with its allowed-tools granted, and splices the output in', async () => {
    const bash = fakeBash()
    try {
      const [block] = await skillCommand('skills', ['Bash(echo:*)']).getPromptForCommand('go', context())
      expect(block).toEqual({
        type: 'text',
        text: 'Inline: ran(echo zz-inline)\n\nran(echo zz-block)\nArgs: go',
      })
      expect(bash).toHaveBeenCalledTimes(2)
      expect(seenAllowRules).toEqual([['Bash(echo:*)'], ['Bash(echo:*)']])
    } finally {
      bash.mockRestore()
    }
  })
})
