/**
 * Where a style ends, which the characterization suites cannot see: they read
 * only the codes right before a word, so a colour or bold carried over from
 * the word before passes them. These read the state still active at a word.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import { PermissionExplainerContent } from 'src/permissions/ui/PermissionExplanation.js'
import { PermissionDecisionDebugInfo } from 'src/permissions/ui/PermissionDecisionDebugInfo.js'
import * as rig from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { PermissionExplanation } from 'src/permissions/permissionExplainer.js'
import type { PermissionDecisionReason } from 'src/permissions/PermissionResult.js'

rig.isolatedWorld()
rig.withTruecolor()

type ActiveStyle = { bold: boolean; foreground: boolean }

/** Replays every SGR code before `text` and reports what is still on there. */
function activeStyleAt(styled: string, text: string): ActiveStyle {
  const at = styled.indexOf(text)
  if (at < 0) throw new Error(`${JSON.stringify(text)} is not on the screen`)
  const state: ActiveStyle = { bold: false, foreground: false }
  for (const [, params] of styled.slice(0, at).matchAll(/\u001B\[([0-9;]*)m/g)) {
    const codes = (params || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!
      if (code === 0) Object.assign(state, { bold: false, foreground: false })
      else if (code === 1) state.bold = true
      else if (code === 22) state.bold = false
      else if (code === 39) state.foreground = false
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.foreground = true
      else if (code === 38) {
        state.foreground = true
        i += codes[i + 1] === 2 ? 4 : 2
      } else if (code === 48) i += codes[i + 1] === 2 ? 4 : 2
    }
  }
  return state
}

describe('the risk line', () => {
  test('the colour ends with the label; the risk text is drawn uncoloured', async () => {
    const explanation: PermissionExplanation = { riskLevel: 'MEDIUM', explanation: 'e', reasoning: 'r', risk: 'plain-risk-words' }
    const screen = await rig.mount(
      <Box flexDirection="column">
        <Text>host</Text>
        <PermissionExplainerContent visible promise={Promise.resolve(explanation)} />
      </Box>,
    )
    await screen.until(frame => frame.includes('plain-risk-words'), 'the risk line')
    expect(activeStyleAt(screen.styled(), 'Med risk').foreground).toBe(true)
    expect(activeStyleAt(screen.styled(), 'plain-risk-words').foreground).toBe(false)
  }, rig.SLOW)
})

describe('the debug reason line', () => {
  const kinds: Array<[string, PermissionDecisionReason, string, string]> = [
    [
      'rule',
      { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'Bash', ruleContent: 'make' } } },
      'Bash(make)',
      'rule from',
    ],
    ['hook', { type: 'hook', hookName: 'PreToolUse:guard', reason: 'too wide' }, 'PreToolUse:guard', 'hook: too wide'],
    ['prompt tool', { type: 'permissionPromptTool', permissionPromptToolName: 'mcp__gate', toolResult: {} }, 'mcp__gate', 'permission prompt tool'],
  ]
  for (const [kind, decisionReason, name, rest] of kinds) {
    test(`${kind}: the bold ends with the name`, async () => {
      const screen = await rig.mount(
        <PermissionDecisionDebugInfo permissionResult={{ behavior: 'ask', message: 'm', decisionReason }} />,
        { columns: 120 },
      )
      await screen.until(frame => frame.includes(rest), 'the reason')
      expect(activeStyleAt(screen.styled(), name).bold).toBe(true)
      expect(activeStyleAt(screen.styled(), rest).bold).toBe(false)
    }, rig.SLOW)
  }
})
