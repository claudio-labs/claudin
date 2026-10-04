/**
 * Characterization of the dialog that asks before a skill runs. Written
 * before the clean-base rewrite of permissions/toolDialogs; the spec is
 * docs/tech/rewrite/permissions/toolDialogs.md.
 *
 * Reached through `PermissionRequest` with the real SkillTool. The rules its
 * "don't ask again" options write are what SkillTool's own permission check
 * reads back on the next call, so each one is pinned character for character.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { Text } from 'src/terminal/ink.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { flat, isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()
withTruecolor()
const { enter, esc, tab, down } = KEYS
const chars = (text: string) => [...text]

const withCommand = (description: string): PermissionDecision =>
  ({ behavior: 'ask', message: 'Execute skill', metadata: { command: { description } } }) as unknown as PermissionDecision

const askSkill = (input: Record<string, unknown>, extra: { permissionResult?: PermissionDecision } = {}) =>
  ask({ tool: SkillTool, input, ...extra })

const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))

describe('SkillPermissionRequest: what it shows', () => {
  test(
    'a one-word skill: the headline names it, a note on what a skill may do, the description, and three options',
    async () => {
      const { screen } = await askSkill({ skill: 'release' }, { permissionResult: withCommand('Cuts a release') })
      expect(shown(screen.text())).toEqual([
        '─'.repeat(120),
        'Use skill "release"?',
        'Claude may use instructions, code, or files from this Skill.',
        'Cuts a release',
        'Do you want to proceed?',
        '❯ 1. Yes',
        `2. Yes, and don't ask again for release in ${world().project}`,
        '3. No',
        'Esc to cancel · Tab to amend',
      ])
    },
    SLOW,
  )

  test(
    'with no command behind the request there is no description line',
    async () => {
      const { screen } = await askSkill({ skill: 'release' })
      const lines = shown(screen.text())
      expect(lines.slice(1, 4)).toEqual(['Use skill "release"?', 'Claude may use instructions, code, or files from this Skill.', 'Do you want to proceed?'])
    },
    SLOW,
  )

  test(
    'the description only comes from an ask: an allow carrying the same metadata shows none',
    async () => {
      const allow = { behavior: 'allow', updatedInput: {}, metadata: { command: { description: 'Cuts a release' } } } as unknown as PermissionDecision
      const { screen } = await askSkill({ skill: 'release' }, { permissionResult: allow })
      expect(screen.text()).not.toContain('Cuts a release')
    },
    SLOW,
  )

  type Shape = { skill: string; options: string[] }
  const shapes: Shape[] = [
    { skill: 'release', options: ['Yes', "Yes, and don't ask again for release in <cwd>", 'No'] },
    { skill: 'review pr', options: ['Yes', "Yes, and don't ask again for review pr in <cwd>", "Yes, and don't ask again for review:* commands in <cwd>", 'No'] },
    { skill: 'a b c', options: ['Yes', "Yes, and don't ask again for a b c in <cwd>", "Yes, and don't ask again for a:* commands in <cwd>", 'No'] },
    { skill: '/commit', options: ['Yes', "Yes, and don't ask again for /commit in <cwd>", 'No'] },
    { skill: 'plugin:deploy', options: ['Yes', "Yes, and don't ask again for plugin:deploy in <cwd>", 'No'] },
    // A space at the very start does not split off a prefix.
    { skill: ' lead', options: ['Yes', "Yes, and don't ask again for  lead in <cwd>", 'No'] },
  ]
  for (const shape of shapes) {
    test(
      `the options for ${JSON.stringify(shape.skill)}`,
      async () => {
        const { screen } = await askSkill({ skill: shape.skill })
        const labels = optionLines(screen.text()).map(line => line.replace(/^(❯ )?\d\. /, ''))
        expect(labels).toEqual(shape.options.map(option => option.replace('<cwd>', world().project)))
        expect(shown(screen.text())[1]).toBe(`Use skill "${shape.skill}"?`)
      },
      SLOW,
    )
  }

  test(
    'styling: the description is dim; the skill, the prefix and the directory in the always options are bold',
    async () => {
      const { screen } = await askSkill({ skill: 'review pr' }, { permissionResult: withCommand('Reviews a PR') })
      const styled = screen.styled()
      const reference = async (props: React.ComponentProps<typeof Text>) => {
        const probe = await mount(<Text {...props}>SAMPLE</Text>)
        const codes = styleBefore(probe.styled(), 'SAMPLE')
        await probe.close()
        return codes
      }
      const dim = await reference({ dimColor: true })
      const bold = await reference({ bold: true })
      expect(styleBefore(styled, 'Reviews a PR')).toBe(dim)
      const options = styled.slice(styled.indexOf('ask again for'))
      expect(styleBefore(options, 'review pr')).toBe(bold)
      expect(styleBefore(options, 'review:*')).toBe(bold)
      expect(styleBefore(options, world().project)).toBe(bold)
      expect(styleBefore(styled, 'Claude may use')).toBe('')
    },
    SLOW,
  )

  test(
    'the worker badge joins the headline, and the reason the prompt asked is shown',
    async () => {
      const { screen } = await ask({
        tool: SkillTool,
        input: { skill: 'release' },
        workerBadge: { name: 'builder', color: 'green' },
        permissionResult: { behavior: 'ask', message: 'asking', decisionReason: { type: 'other', reason: 'Skills need a yes here' } },
      })
      expect(shown(screen.text())[1]).toBe('Use skill "release"? · @builder')
      expect(flat(screen.text())).toContain('Skills need a yes here Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'managed policy keeps rules to itself: no always option, even for a skill with a prefix',
    async () => {
      managedRulesOnly(world().home)
      const { screen } = await askSkill({ skill: 'review pr' })
      expect(optionLines(screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )
})

describe('SkillPermissionRequest: what each answer reports', () => {
  const ONE = { skill: 'release' }
  const TWO = { skill: 'review pr', args: '42' }
  type Row = { name: string; input: Record<string, unknown>; keys: string[]; calls: Call[]; escapes?: number; managed?: boolean }
  const rows: Row[] = [
    { name: 'Enter on Yes: allow once', input: ONE, keys: [enter], calls: allowed(ONE, [], undefined) },
    { name: 'Yes with a note', input: ONE, keys: [tab, ...chars(' go '), enter], calls: allowed(ONE, [], 'go') },
    { name: '2 for a one-word skill: a Skill rule for exactly that skill', input: ONE, keys: ['2'], calls: allowed(ONE, [allowRule('Skill', 'release')]) },
    { name: '3 for a one-word skill is No', input: ONE, keys: ['3'], calls: denied(undefined) },
    { name: '2 for a skill with a space: the exact rule holds the whole string', input: TWO, keys: ['2'], calls: allowed(TWO, [allowRule('Skill', 'review pr')]) },
    { name: '3 for a skill with a space: a prefix rule on its first word', input: TWO, keys: ['3'], calls: allowed(TWO, [allowRule('Skill', 'review:*')]) },
    { name: 'Down, Down, Enter: the prefix rule', input: TWO, keys: [down, down, enter], calls: allowed(TWO, [allowRule('Skill', 'review:*')]) },
    { name: '4 for a skill with a space is No', input: TWO, keys: ['4'], calls: denied(undefined) },
    { name: 'No with a note', input: TWO, keys: [down, down, down, tab, ...chars('not now'), enter], calls: denied('not now') },
    { name: 'a leading slash stays in the rule', input: { skill: '/commit' }, keys: ['2'], calls: allowed({ skill: '/commit' }, [allowRule('Skill', '/commit')]) },
    { name: 'a namespaced skill: the rule holds the full name', input: { skill: 'plugin:deploy' }, keys: ['2'], calls: allowed({ skill: 'plugin:deploy' }, [allowRule('Skill', 'plugin:deploy')]) },
    { name: 'a prefix rule keeps only the first word of three', input: { skill: 'a b c' }, keys: ['3'], calls: allowed({ skill: 'a b c' }, [allowRule('Skill', 'a:*')]) },
    { name: 'Esc: deny with no arguments, one escape counted', input: TWO, keys: [esc], calls: denied(), escapes: 1 },
    { name: 'Esc with a Yes note written: still a deny', input: ONE, keys: [tab, ...chars('ok'), esc], calls: denied(), escapes: 1 },
    { name: 'y and n: nothing', input: ONE, keys: ['y', 'n'], calls: [] },
    { name: 'managed policy: 2 is No', input: TWO, keys: ['2'], calls: denied(undefined), managed: true },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.managed) managedRulesOnly(world().home)
        const asked = await askSkill(row.input)
        expect(await answer(asked, row.keys)).toEqual(row.calls)
        expect(asked.screen.state().attribution.escapeCount).toBe(row.escapes ?? 0)
      },
      SLOW,
    )
  }

  test(
    'an input the skill tool cannot read: the dialog still opens, and Yes allows that input once',
    async () => {
      const odd = { name: 'release' }
      const asked = await askSkill(odd)
      expect(shown(asked.screen.text())[1]).toStartWith('Use skill ')
      expect(await answer(asked, ['1'])).toEqual(allowed(odd, [], undefined))
    },
    SLOW,
  )

  test(
    'the dialog counts one permission prompt',
    async () => {
      const asked = await askSkill(ONE)
      await asked.screen.until(() => asked.screen.state().attribution.permissionPromptCount === 1, 'the prompt count')
    },
    SLOW,
  )
})
