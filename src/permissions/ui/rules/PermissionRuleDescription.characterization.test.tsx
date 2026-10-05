/**
 * permissions/ruleList: `PermissionRuleDescription`, the one-line gloss under
 * a rule in the /permissions details and in the "add rules" dialog.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import { PermissionRuleDescription } from 'src/permissions/ui/rules/PermissionRuleDescription.js'
import { isolatedWorld, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Box, Text } from 'src/terminal/ink.js'

isolatedWorld()
withTruecolor()

const END = '[end of gloss]'

async function gloss(ruleValue: PermissionRuleValue) {
  const screen = await mount(
    <Box flexDirection="column">
      <PermissionRuleDescription ruleValue={ruleValue} />
      <Text>{END}</Text>
    </Box>,
    { columns: 100, ready: frame => frame.includes(END) },
  )
  const lines = screen
    .text()
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  return { lines: lines.slice(0, lines.indexOf(END)), styled: screen.styled() }
}

const CASES: { rule: PermissionRuleValue; says: string | null; bold?: string }[] = [
  { rule: { toolName: 'Bash' }, says: 'Any Bash command' },
  { rule: { toolName: 'Bash', ruleContent: '' }, says: 'Any Bash command' },
  { rule: { toolName: 'Bash', ruleContent: 'npm test:*' }, says: 'Any Bash command starting with npm test', bold: 'npm test' },
  { rule: { toolName: 'Bash', ruleContent: 'git log --oneline:*' }, says: 'Any Bash command starting with git log --oneline', bold: 'git log --oneline' },
  { rule: { toolName: 'Bash', ruleContent: 'git status' }, says: 'The Bash command git status', bold: 'git status' },
  { rule: { toolName: 'Bash', ruleContent: 'docker *' }, says: 'The Bash command docker *', bold: 'docker *' },
  { rule: { toolName: 'Bash', ruleContent: 'echo a:* b' }, says: 'The Bash command echo a:* b', bold: 'echo a:* b' },
  { rule: { toolName: 'Read' }, says: 'Any use of the Read tool', bold: 'Read' },
  { rule: { toolName: 'mcp__github__create_issue' }, says: 'Any use of the mcp__github__create_issue tool', bold: 'mcp__github__create_issue' },
  { rule: { toolName: 'Read', ruleContent: '/etc/**' }, says: null },
  { rule: { toolName: 'WebFetch', ruleContent: 'domain:example.com' }, says: null },
  { rule: { toolName: 'Agent', ruleContent: 'Explore' }, says: null },
]

describe('what each rule is glossed as', () => {
  for (const { rule, says, bold } of CASES) {
    const name = `${rule.toolName}${rule.ruleContent === undefined ? '' : `(${rule.ruleContent})`}`
    test(`${name} → ${says === null ? 'nothing' : JSON.stringify(says)}`, async () => {
      const { lines, styled } = await gloss(rule)
      if (says === null) {
        expect(lines).toEqual([])
        return
      }
      expect(lines.map(line => line.trim())).toEqual([says])
      // The whole line is dim (the same style the line opens with), the named part bold.
      const opening = styleBefore(styled, says.split(' ')[0]!)
      expect(opening).not.toBe('')
      expect(opening).not.toContain('\u001B[1m')
      if (bold) expect(styleBefore(styled, bold)).toContain('\u001B[1m')
    }, SLOW)
  }

  test('a bare ":*" reads as a prefix with nothing after "starting with"', async () => {
    const { lines } = await gloss({ toolName: 'Bash', ruleContent: ':*' })
    expect(lines.map(line => line.trim())).toEqual(['Any Bash command starting with'])
  }, SLOW)

  test('the Bash gloss and the any-use gloss share one dim style', async () => {
    const bash = (await gloss({ toolName: 'Bash' })).styled
    const read = (await gloss({ toolName: 'Read' })).styled
    expect(styleBefore(bash, 'Any Bash command')).toBe(styleBefore(read, 'Any use of the'))
  }, SLOW)
})
