import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import type { Command } from 'src/commands/commands.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { COMPACT_SKILL_PROMPT, getPrompt } from 'src/tools/SkillTool/prompt.js'
import { renderToolUseMessage } from 'src/tools/SkillTool/UI.js'

function createPromptCommand(
  name: string,
  options: {
    source?: 'builtin' | 'plugin' | 'mcp' | 'bundled'
    loadedFrom?: Command['loadedFrom']
  } = {},
): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    progressMessage: `${name} progress`,
    contentLength: 0,
    source: options.source ?? 'builtin',
    loadedFrom: options.loadedFrom,
    async getPromptForCommand() {
      return []
    },
  }
}

describe('SkillTool missing parameter handling', () => {
  test('missing skill stays required at the schema level', async () => {
    const parsed = SkillTool.inputSchema.safeParse({})

    expect(parsed.success).toBe(false)
  })

  test('validateInput still returns an actionable error when called with missing skill', async () => {
    const result = await SkillTool.validateInput?.({} as never, {
      options: { tools: [] },
      messages: [],
    } as never)

    expect(result).toEqual({
      result: false,
      message:
        'Missing skill name. Pass the slash command name as the skill parameter (e.g., skill: "commit" for /commit, skill: "review-pr" for /review-pr).',
      errorCode: 1,
    })
  })

  test('valid skill input still parses and validates', async () => {
    const parsed = SkillTool.inputSchema.safeParse({ skill: 'commit' })

    expect(parsed.success).toBe(true)
  })
})

describe('SkillTool renderToolUseMessage', () => {
  test('plugin skills render correctly without plugin command metadata', () => {
    const pluginSkillName = 'plugin:review-pr'

    expect(
      renderToolUseMessage(
        { skill: pluginSkillName },
        {
          commands: [],
        },
      ),
    ).toBe(pluginSkillName)

    expect(
      renderToolUseMessage(
        { skill: pluginSkillName },
        {
          commands: [
            createPromptCommand(pluginSkillName, {
              source: 'plugin',
              loadedFrom: 'plugin',
            }),
          ],
        },
      ),
    ).toBe(pluginSkillName)
  })

  test('legacy commands still render with a slash prefix when metadata is present', () => {
    expect(
      renderToolUseMessage(
        { skill: 'legacy-command' },
        {
          commands: [
            createPromptCommand('legacy-command', {
              loadedFrom: 'commands_DEPRECATED',
            }),
          ],
        },
      ),
    ).toBe('/legacy-command')
  })
})

describe('SkillTool prompt', () => {
  test('both texts explain a directory-scoped name', async () => {
    for (const text of [COMPACT_SKILL_PROMPT, await getPrompt('/repo')]) {
      expect(text).toContain('listed with that directory as a prefix')
      expect(text).toContain('apps/web:deploy')
      expect(text).toContain('the bare name runs the other one')
    }
  })

  test("both texts say a background skill's result comes as a notification", async () => {
    for (const text of [COMPACT_SKILL_PROMPT, await getPrompt('/repo')]) {
      expect(text).toContain('A skill that runs in the background returns only its agent')
      expect(text).toContain("don't wait on it or invoke it again meanwhile")
    }
  })

  // call() reaches the background path only with a live agent run; pin the wiring.
  test('call launches a background fork before the foreground fork path', () => {
    const source = readFileSync(new URL('./SkillTool.ts', import.meta.url), 'utf8')
    const background = source.indexOf("command?.type === 'prompt' && shouldRunSkillInBackground(command, context.agentId, isRunInBackgroundHidden())")
    const foreground = source.indexOf("if (command?.type === 'prompt' && command.context === 'fork') {")
    expect(background).toBeGreaterThan(-1)
    expect(foreground).toBeGreaterThan(background)
  })
})
