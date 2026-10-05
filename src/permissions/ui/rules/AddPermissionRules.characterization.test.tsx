/**
 * Characterization of the "where should this rule be saved?" step of
 * /permissions, written before the clean-base rewrite of
 * permissions/ruleEditors. The spec is docs/tech/rewrite/permissions/ruleEditors.md.
 *
 * The rule text has already been parsed by the input step; this dialog shows
 * it, asks for a settings file, writes it there, hands the caller the new
 * session context and reports which of the new rules can never take effect.
 * Every answer is checked against the settings files on disk and against the
 * full, ordered list of what the dialog told its caller.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as React from 'react'
import type { PermissionBehavior, PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import { flat, isolatedWorld, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { managedRulesOnly } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import { AddPermissionRules, optionForPermissionSaveDestination } from 'src/permissions/ui/rules/AddPermissionRules.js'
import { SOURCES } from 'src/platform/settings/constants.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'

const world = isolatedWorld()
const { enter, esc, down, up } = KEYS

type Report =
  | { to: 'context'; context: ToolPermissionContext }
  | { to: 'added'; rules: unknown; unreachable: unknown }
  | { to: 'cancel' }

type Opened = { reports: Report[]; press: (...keys: string[]) => Promise<void>; text: () => string }

async function open(
  ruleValues: PermissionRuleValue[],
  ruleBehavior: PermissionBehavior,
  initialContext: ToolPermissionContext = getEmptyToolPermissionContext(),
): Promise<Opened> {
  const reports: Report[] = []
  const screen = await mount(
    <AddPermissionRules
      ruleValues={ruleValues}
      ruleBehavior={ruleBehavior}
      initialContext={initialContext}
      onAddRules={(rules, unreachable) => reports.push({ to: 'added', rules, unreachable })}
      onCancel={() => reports.push({ to: 'cancel' })}
      setToolPermissionContext={context => reports.push({ to: 'context', context })}
    />,
    { ready: frame => frame.includes('User settings') },
  )
  return { reports, press: screen.press, text: screen.text }
}

/** Where each destination lives in the isolated world. */
function fileOf(destination: string): string {
  const { project, config } = world()
  const at: Record<string, string> = {
    localSettings: join(project, '.claudin', 'settings.local.json'),
    projectSettings: join(project, '.claudin', 'settings.json'),
    userSettings: join(config, 'settings.json'),
  }
  return at[destination]!
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))
const writtenFiles = () => SOURCES.filter(source => existsSync(fileOf(source)))

function seed(destination: string, content: string): void {
  const path = fileOf(destination)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  resetSettingsCache()
}

/** The keys that move the pointer to the n-th destination (0-based) and confirm. */
const pick = (index: number) => [...Array<string>(index).fill(down), enter]

const BASH_NPM: PermissionRuleValue = { toolName: 'Bash', ruleContent: 'npm test' }
const READ_ALL: PermissionRuleValue = { toolName: 'Read' }

describe('optionForPermissionSaveDestination', () => {
  test('each editable source maps to a label, a line saying where the file is, and its own value', () => {
    const table = [
      ['localSettings', 'Project settings (local)', 'Saved in .claudin/settings.local.json'],
      ['projectSettings', 'Project settings', 'Checked in at .claudin/settings.json'],
      ['userSettings', 'User settings', 'Saved in ~/.claudin/settings.json'],
    ] as const
    for (const [source, label, description] of table) {
      expect(optionForPermissionSaveDestination(source)).toEqual({ label, description, value: source })
    }
  })

  test('the user-settings line names ~/.claudin even when the config home is elsewhere', () => {
    expect(process.env.CLAUDIN_CONFIG_DIR).toBe(world().config)
    expect(optionForPermissionSaveDestination('userSettings').description as unknown).toBe('Saved in ~/.claudin/settings.json')
  })
})

describe('AddPermissionRules: what it shows', () => {
  test(
    'one rule: the title names the behaviour, the rule and its description, the question, the three files and the hint',
    async () => {
      const dialog = await open([BASH_NPM], 'allow')
      const lines = linesOf(dialog.text()).map(line => line.trim()).filter(line => line !== '')
      expect(lines).toEqual([
        '─'.repeat(80),
        'Add allow permission rule',
        'Bash(npm test)',
        'The Bash command npm test',
        'Where should this rule be saved?',
        '❯ 1. Project settings (local)  Saved in .claudin/settings.local.json',
        '2. Project settings          Checked in at .claudin/settings.json',
        '3. User settings             Saved in ~/.claudin/settings.json',
        'Enter to confirm · Esc to cancel',
      ])
    },
    SLOW,
  )

  test(
    'several rules: plural title and question, each rule in the order given',
    async () => {
      const values = [BASH_NPM, READ_ALL, { toolName: 'WebFetch', ruleContent: 'domain:example.com' }]
      for (const behavior of ['deny', 'ask'] as const) {
        const dialog = await open(values, behavior)
        const text = flat(dialog.text())
        expect(text).toContain(`Add ${behavior} permission rules`)
        expect(text).toContain('Where should these rules be saved?')
        const at = values.map(value => text.indexOf(permissionRuleValueToString(value)))
        expect(at.every(position => position >= 0)).toBe(true)
        expect([...at].sort((a, b) => a - b)).toEqual(at)
      }
    },
    SLOW,
  )
})

describe('AddPermissionRules: saving', () => {
  const destinations = [
    ['localSettings', 0],
    ['projectSettings', 1],
    ['userSettings', 2],
  ] as const

  for (const [destination, index] of destinations) {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      test(
        `${behavior} to ${destination}: that file gets exactly the rules, the context gets them in that slot, the caller is told`,
        async () => {
          const dialog = await open([BASH_NPM, READ_ALL], behavior)
          await dialog.press(...pick(index))

          expect(writtenFiles() as unknown).toEqual([destination])
          expect(readJson(fileOf(destination))).toEqual({ permissions: { [behavior]: ['Bash(npm test)', 'Read'] } })

          const key = { allow: 'alwaysAllowRules', deny: 'alwaysDenyRules', ask: 'alwaysAskRules' }[behavior]
          const expected = { ...getEmptyToolPermissionContext(), [key]: { [destination]: ['Bash(npm test)', 'Read'] } }
          expect(dialog.reports).toEqual([
            { to: 'context', context: expected },
            {
              to: 'added',
              rules: [BASH_NPM, READ_ALL].map(ruleValue => ({ ruleValue, ruleBehavior: behavior, source: destination })),
              unreachable: undefined,
            },
          ])
        },
        SLOW,
      )
    }
  }

  test(
    'up from the first destination wraps round to the last one, the user settings',
    async () => {
      const dialog = await open([READ_ALL], 'allow')
      await dialog.press(up, enter)
      expect(writtenFiles() as unknown).toEqual(['userSettings'])
    },
    SLOW,
  )

  test(
    'the rule is written as shown: escaped content, a wildcard and an empty content all round-trip to what the dialog showed',
    async () => {
      const values: PermissionRuleValue[] = [
        { toolName: 'Bash', ruleContent: 'python -c "print(1)"' },
        { toolName: 'Bash', ruleContent: 'C:\\tools\\run' },
        { toolName: 'Bash', ruleContent: 'git log:*' },
        { toolName: 'mcp__deploy__ship' },
      ]
      const dialog = await open(values, 'deny')
      const shown = values.map(permissionRuleValueToString)
      for (const rule of shown) expect(dialog.text()).toContain(rule)
      await dialog.press(enter)
      expect(readJson(fileOf('localSettings'))).toEqual({ permissions: { deny: shown } })
    },
    SLOW,
  )

  test(
    'a rule with content is never written as the whole tool, and Bash(*) is written as the whole tool it already is',
    async () => {
      const dialog = await open([{ toolName: 'Bash', ruleContent: 'rm build' }, { toolName: 'Edit', ruleContent: '*' }], 'allow')
      expect(dialog.text()).toContain('Edit(*)')
      await dialog.press(enter)
      expect(readJson(fileOf('localSettings'))).toEqual({ permissions: { allow: ['Bash(rm build)', 'Edit'] } })
      const context = dialog.reports[0] as { context: ToolPermissionContext }
      expect(context.context.alwaysAllowRules).toEqual({ localSettings: ['Bash(rm build)', 'Edit'] })
    },
    SLOW,
  )

  test(
    'what the file already holds is kept, and a rule already there (in any spelling) is not written twice',
    async () => {
      seed('projectSettings', JSON.stringify({ model: 'kept-model', permissions: { allow: ['Read', 'Bash(ls)'], deny: ['Write'] } }))
      const dialog = await open([{ toolName: 'Bash', ruleContent: 'ls' }, BASH_NPM, { toolName: 'Read', ruleContent: '*' }], 'allow')
      await dialog.press(...pick(1))
      expect(readJson(fileOf('projectSettings'))).toEqual({
        model: 'kept-model',
        permissions: { allow: ['Read', 'Bash(ls)', 'Bash(npm test)'], deny: ['Write'] },
      })
    },
    SLOW,
  )

  test(
    'the new context keeps every other slot of the context it was given',
    async () => {
      const initial: ToolPermissionContext = {
        ...getEmptyToolPermissionContext(),
        mode: 'acceptEdits',
        alwaysAllowRules: { userSettings: ['Glob'], localSettings: ['Grep'] },
        alwaysDenyRules: { session: ['Write'] },
        additionalWorkingDirectories: new Map([['/srv/data', { path: '/srv/data', source: 'session' }]]),
      }
      const dialog = await open([BASH_NPM], 'allow', initial)
      await dialog.press(enter)
      const { context } = dialog.reports[0] as { context: ToolPermissionContext }
      expect(context).toEqual({ ...initial, alwaysAllowRules: { userSettings: ['Glob'], localSettings: ['Grep', 'Bash(npm test)'] } })
      expect(initial.alwaysAllowRules).toEqual({ userSettings: ['Glob'], localSettings: ['Grep'] })
    },
    SLOW,
  )
})

describe('AddPermissionRules: leaving without saving', () => {
  test(
    'Esc: only the cancel is reported, and no settings file is created',
    async () => {
      const dialog = await open([BASH_NPM], 'allow')
      await dialog.press(down, esc)
      expect(dialog.reports).toEqual([{ to: 'cancel' }])
      expect(writtenFiles()).toEqual([])
    },
    SLOW,
  )

  test(
    'moving the pointer saves nothing',
    async () => {
      const dialog = await open([BASH_NPM], 'allow')
      await dialog.press(down, down)
      expect(dialog.reports).toEqual([])
      expect(writtenFiles()).toEqual([])
    },
    SLOW,
  )
})

describe('AddPermissionRules: rules that cannot take effect', () => {
  type Case = {
    name: string
    behavior: PermissionBehavior
    add: PermissionRuleValue[]
    context: Partial<ToolPermissionContext>
    expected: Array<{ rule: string; shadowType: string; by: string; bySource: string }>
  }
  const cases: Case[] = [
    {
      name: 'an allow under a tool-wide deny is reported as blocked by it',
      behavior: 'allow',
      add: [BASH_NPM],
      context: { alwaysDenyRules: { userSettings: ['Bash'] } },
      expected: [{ rule: 'Bash(npm test)', shadowType: 'deny', by: 'Bash', bySource: 'userSettings' }],
    },
    {
      name: 'an allow under a tool-wide ask is reported as shadowed by it',
      behavior: 'allow',
      add: [BASH_NPM],
      context: { alwaysAskRules: { projectSettings: ['Bash'] } },
      expected: [{ rule: 'Bash(npm test)', shadowType: 'ask', by: 'Bash', bySource: 'projectSettings' }],
    },
    {
      name: 'with the sandbox off, a personal tool-wide Bash ask still shadows a Bash allow',
      behavior: 'allow',
      add: [BASH_NPM],
      context: { alwaysAskRules: { userSettings: ['Bash'] } },
      expected: [{ rule: 'Bash(npm test)', shadowType: 'ask', by: 'Bash', bySource: 'userSettings' }],
    },
    {
      name: 'only the new rules are reported, not an older unreachable one',
      behavior: 'allow',
      add: [{ toolName: 'Edit', ruleContent: 'src/**' }, READ_ALL],
      context: { alwaysDenyRules: { userSettings: ['Edit', 'Bash'] }, alwaysAllowRules: { userSettings: ['Bash(ls)'] } },
      expected: [{ rule: 'Edit(src/**)', shadowType: 'deny', by: 'Edit', bySource: 'userSettings' }],
    },
    { name: 'a deny is never reported', behavior: 'deny', add: [BASH_NPM], context: { alwaysDenyRules: { userSettings: ['Bash'] } }, expected: [] },
    { name: 'an ask is never reported', behavior: 'ask', add: [BASH_NPM], context: { alwaysDenyRules: { userSettings: ['Bash'] } }, expected: [] },
    {
      name: 'a deny of a different tool shadows nothing',
      behavior: 'allow',
      add: [BASH_NPM],
      context: { alwaysDenyRules: { userSettings: ['Write'] } },
      expected: [],
    },
    {
      name: 'a narrower deny of the same tool shadows nothing',
      behavior: 'allow',
      add: [BASH_NPM],
      context: { alwaysDenyRules: { userSettings: ['Bash(rm:*)'] } },
      expected: [],
    },
  ]

  for (const c of cases) {
    test(
      c.name,
      async () => {
        const dialog = await open(c.add, c.behavior, { ...getEmptyToolPermissionContext(), ...c.context })
        await dialog.press(enter)
        const added = dialog.reports.find(report => report.to === 'added') as { unreachable?: Array<Record<string, any>> }
        if (c.expected.length === 0) {
          expect(added.unreachable).toBeUndefined()
          return
        }
        const seen = (added.unreachable ?? []).map(u => ({
          rule: permissionRuleValueToString(u.rule.ruleValue),
          shadowType: u.shadowType,
          by: permissionRuleValueToString(u.shadowedBy.ruleValue),
          bySource: u.shadowedBy.source,
        }))
        expect(seen).toEqual(c.expected)
        for (const u of added.unreachable ?? []) {
          expect(u.rule.source).toBe('localSettings')
          expect(u.rule.ruleBehavior).toBe('allow')
          expect(u.reason).toContain(`"${u.shadowedBy.ruleValue.toolName}" ${u.shadowType} rule`)
          expect(u.fix).toContain('local')
        }
      },
      SLOW,
    )
  }
})

describe('AddPermissionRules: a save the settings layer refuses', () => {
  test(
    'with managed settings keeping rules to the policy, no file is written',
    async () => {
      managedRulesOnly(world().home)
      for (const index of [0, 1, 2]) {
        const dialog = await open([BASH_NPM], 'allow')
        await dialog.press(...pick(index))
      }
      expect(writtenFiles()).toEqual([])
    },
    SLOW,
  )

  test(
    'a settings file that is not valid JSON is left byte for byte as it was',
    async () => {
      seed('localSettings', '{ "permissions": { "allow": [ broken')
      const dialog = await open([BASH_NPM], 'allow')
      await dialog.press(enter)
      expect(readFileSync(fileOf('localSettings'), 'utf8')).toBe('{ "permissions": { "allow": [ broken')
    },
    SLOW,
  )
})
