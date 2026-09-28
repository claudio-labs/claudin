import { describe, expect, test } from 'bun:test'

// MACRO is replaced at build time by Bun.define but not in test mode.
;(globalThis as Record<string, unknown>).MACRO = {
  ...((globalThis as Record<string, unknown>).MACRO as object),
  ISSUES_EXPLAINER:
    'report the issue at https://github.com/claudio-labs/claudin/issues',
}

import { CLAUDE_CODE_GUIDE_AGENT } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'

function guidePrompt(): string {
  return CLAUDE_CODE_GUIDE_AGENT.getSystemPrompt({
    toolUseContext: {
      options: {
        commands: [],
        agentDefinitions: { activeAgents: [] },
        mcpClients: [],
      } as never,
    },
  })
}

describe('claudin-guide system prompt', () => {
  test('sends Claudin questions to the claudiolabs.ai docs index first', () => {
    const prompt = guidePrompt()
    expect(prompt).toContain('https://claudiolabs.ai/llms.txt')
    expect(prompt).toContain('https://claudiolabs.ai/docs/')
  })

  test('no longer points at the Claude Code docs', () => {
    expect(guidePrompt()).not.toContain('code.claude.com')
  })

  test('sends unanswered questions to the issue tracker, never to /feedback', () => {
    const prompt = guidePrompt()
    expect(prompt).not.toContain('/feedback')
    expect(prompt).toContain('https://github.com/claudio-labs/claudin/issues')
  })
})
