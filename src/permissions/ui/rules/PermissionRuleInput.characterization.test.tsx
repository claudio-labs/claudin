/**
 * permissions/ruleList: `PermissionRuleInput`, where /permissions takes the
 * text of a new rule. It parses what was typed and hands the rule value up
 * with the kind it was opened for; saving is the caller's business.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionBehavior, PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import { PermissionRuleInput } from 'src/permissions/ui/rules/PermissionRuleInput.js'
import { isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

isolatedWorld()
withTruecolor()

type Said = { to: 'submit'; value: PermissionRuleValue; behavior: PermissionBehavior } | { to: 'cancel' }

async function openInput(behavior: PermissionBehavior) {
  const said: Said[] = []
  const screen = await mount(
    <PermissionRuleInput
      ruleBehavior={behavior}
      onSubmit={(value, kind) => said.push({ to: 'submit', value, behavior: kind })}
      onCancel={() => said.push({ to: 'cancel' })}
    />,
    { columns: 100, ready: frame => frame.includes('Enter to submit') },
  )
  const type = async (text: string) => {
    for (const ch of text) await screen.press(ch)
  }
  return { screen, said, type }
}

describe('the screen', () => {
  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    test(`opened for ${behavior}: title, how a rule is written, two examples, the field and the keys`, async () => {
      const { screen } = await openInput(behavior)
      const lines = screen
        .text()
        .split('\n')
        .map(line => line.replace(/[│╭╮╰╯─]/g, '').trim())
        .filter(Boolean)
      expect(lines).toEqual([
        `Add ${behavior} permission rule`,
        'Permission rules are a tool name, optionally followed by a specifier in parentheses.',
        'e.g., WebFetch or Bash(ls:*)',
        'Enter permission rule…',
        'Enter to submit · Esc to cancel',
      ])
    }, SLOW)
  }

  test('the title is bold in the colour of the box; the two examples are bold, "or" is not', async () => {
    const { screen } = await openInput('deny')
    const styled = screen.styled()
    const title = styleBefore(styled, 'Add deny permission rule')
    expect(title).toContain('\u001B[1m')
    expect(title).toContain(styleBefore(styled, '╭'))
    expect(styleBefore(styled, 'WebFetch')).toContain('\u001B[1m')
    expect(styleBefore(styled, 'Bash(ls:*)')).toContain('\u001B[1m')
    expect(styleBefore(styled, ' or ')).not.toContain('\u001B[1m')
  }, SLOW)

  for (const [key, name] of [
    [KEYS.ctrlC, 'Ctrl-C'],
    ['\x04', 'Ctrl-D'],
  ] as const) {
    test(`one ${name} replaces the key hint with a request for a second one`, async () => {
      const { screen, said } = await openInput('allow')
      await screen.press(key)
      expect(screen.text()).toContain(`Press ${name} again to exit`)
      expect(screen.text()).not.toContain('Enter to submit')
      expect(said).toEqual([])
    }, SLOW)
  }
})

describe('what Enter hands up', () => {
  const TYPED: { typed: string; value: PermissionRuleValue }[] = [
    { typed: 'Read', value: { toolName: 'Read' } },
    { typed: 'Bash(npm run build)', value: { toolName: 'Bash', ruleContent: 'npm run build' } },
    { typed: '   Bash(ls:*)   ', value: { toolName: 'Bash', ruleContent: 'ls:*' } },
    { typed: 'WebFetch(domain:example.com)', value: { toolName: 'WebFetch', ruleContent: 'domain:example.com' } },
    { typed: 'Read(/etc/**)', value: { toolName: 'Read', ruleContent: '/etc/**' } },
    { typed: 'mcp__github', value: { toolName: 'mcp__github' } },
    { typed: 'Bash()', value: { toolName: 'Bash' } },
    { typed: 'Bash(*)', value: { toolName: 'Bash' } },
    { typed: 'Bash(echo \\(hi\\))', value: { toolName: 'Bash', ruleContent: 'echo (hi)' } },
    { typed: 'Task', value: { toolName: 'Agent' } },
  ]
  for (const { typed, value } of TYPED) {
    test(`${JSON.stringify(typed)} → ${JSON.stringify(value)}`, async () => {
      const { screen, said, type } = await openInput('deny')
      await type(typed)
      await screen.press(KEYS.enter)
      expect(said).toEqual([{ to: 'submit', value, behavior: 'deny' }])
    }, SLOW)
  }

  for (const behavior of ['allow', 'ask', 'deny'] as const) {
    test(`the kind handed up is the one it was opened for (${behavior})`, async () => {
      const { screen, said, type } = await openInput(behavior)
      await type('Grep')
      await screen.press(KEYS.enter)
      expect(said).toEqual([{ to: 'submit', value: { toolName: 'Grep' }, behavior }])
    }, SLOW)
  }

  for (const [what, typed] of [
    ['nothing', ''],
    ['only spaces', '    '],
  ] as const) {
    test(`Enter on ${what} hands up nothing and keeps the field open`, async () => {
      const { screen, said, type } = await openInput('allow')
      await type(typed)
      await screen.press(KEYS.enter)
      expect(said).toEqual([])
      expect(screen.text()).toContain('Add allow permission rule')
    }, SLOW)
  }

  test('the typed text shows in the field in place of the placeholder', async () => {
    const { screen, type } = await openInput('allow')
    await type('Bash(git diff)')
    expect(screen.text()).toContain('Bash(git diff)')
    expect(screen.text()).not.toContain('Enter permission rule…')
  }, SLOW)
})

describe('backing out', () => {
  test('Esc cancels, even with text typed, and hands up no rule', async () => {
    const { screen, said, type } = await openInput('deny')
    await type('Write')
    await screen.press(KEYS.esc)
    expect(said).toEqual([{ to: 'cancel' }])
  }, SLOW)

  test('n is text in the field, not a way out', async () => {
    const { screen, said, type } = await openInput('allow')
    await type('n')
    expect(said).toEqual([])
    expect(screen.text()).not.toContain('Enter permission rule…')
  }, SLOW)
})
