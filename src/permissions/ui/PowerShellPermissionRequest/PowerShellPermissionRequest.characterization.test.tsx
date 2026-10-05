/**
 * Characterization of the PowerShell permission dialog, written before the
 * clean-base rewrite of permissions/shellDialogs. The spec is
 * docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * Reached through `PermissionRequest` with the real PowerShellTool. The
 * dialog refines its "don't ask again" field with PowerShell's own parser,
 * which runs `pwsh`. This suite puts a `pwsh` that always fails first on the
 * PATH, so every machine sees the same thing: the parser has nothing to say
 * and the field keeps the command as it was typed.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { PowerShellTool } from 'src/tools/PowerShellTool/PowerShellTool.js'
import type { Tool } from 'src/tools/Tool.js'
import { flat, isolatedWorld, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const failingPwsh = mkdtempSync(join(tmpdir(), 'no-pwsh-'))
writeFileSync(join(failingPwsh, 'pwsh'), '#!/bin/sh\nexit 1\n')
chmodSync(join(failingPwsh, 'pwsh'), 0o755)
process.env.PATH = `${failingPwsh}${delimiter}${process.env.PATH ?? ''}`

const world = isolatedWorld()
const { enter, esc, tab, down, up } = KEYS
const BACKSPACE = '\x7f'
const erase = (n: number) => Array<string>(n).fill(BACKSPACE)
const typed = (text: string) => [...text]

const psRule = (content: string) => ({ toolName: 'PowerShell', ruleContent: content })
const suggesting = (...rules: Array<{ toolName: string; ruleContent?: string }>) => ({
  behavior: 'ask' as const,
  message: 'needs approval',
  suggestions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }],
})
const askPs = (command: string, over: Partial<Ask> = {}) =>
  ask({ tool: PowerShellTool as unknown as Tool, input: { command }, permissionResult: suggesting(psRule('Remove-Item:*')) as never, ...over })

const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))
const hintLine = (frame: string) => shown(frame).find(line => line.startsWith('Esc to cancel')) ?? ''
const settle = () => Bun.sleep(400)

describe('PowerShellPermissionRequest: what it shows', () => {
  test(
    'title, command, request description, question, three options and the hint line',
    async () => {
      const asked = await askPs('Remove-Item build', { description: 'Clean the build output' })
      await settle()
      expect(shown(asked.screen.text())).toEqual([
        '─'.repeat(120),
        'PowerShell command',
        'Remove-Item build',
        'Clean the build output',
        'Do you want to proceed?',
        '❯ 1. Yes',
        '2. Yes, and don’t ask again for: Remove-Item build',
        '3. No',
        'Esc to cancel · Tab to amend · ctrl+e to explain',
      ])
    },
    SLOW,
  )

  const without: Array<[string, Partial<Ask>]> = [
    ['no suggestions', { permissionResult: { behavior: 'ask', message: 'asking' } }],
    ['suggestions on a passthrough result', { permissionResult: { ...suggesting(psRule('Get-Process')), behavior: 'passthrough' } as never }],
  ]
  for (const [name, over] of without) {
    test(
      `${name}: only Yes and No`,
      async () => {
        const asked = await askPs('Get-Process', over)
        expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
      },
      SLOW,
    )
  }

  test(
    'managed policy keeps rules to itself: only Yes and No',
    async () => {
      managedRulesOnly(world().home)
      const asked = await askPs('Get-Process')
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )

  test(
    'the worker badge joins the title, and the reason for asking sits above the question',
    async () => {
      const asked = await askPs('Get-Process', {
        workerBadge: { name: 'ops', color: 'cyan' },
        permissionResult: { ...suggesting(psRule('Get-Process')), decisionReason: { type: 'other', reason: 'Lists processes' } } as never,
      })
      expect(shown(asked.screen.text())[1]).toBe('PowerShell command · @ops')
      expect(flat(asked.screen.text())).toContain('Lists processes Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'the hint drops "Tab to amend" on the allow-always field and in an open note',
    async () => {
      const asked = await askPs('Get-Process')
      await asked.screen.press(down)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · ctrl+e to explain')
      await asked.screen.press(up, tab)
      expect(hintLine(asked.screen.text())).toBe('Esc to cancel · ctrl+e to explain')
    },
    SLOW,
  )

  test(
    'ctrl+d swaps the question for the decision details and back; --debug adds the hints',
    async () => {
      const asked = await askPs('Get-Process', { debug: true })
      expect(flat(shown(asked.screen.text()).at(-1)!)).toBe('Esc to cancel · Tab to amend · ctrl+e to explain Ctrl+d to show debug info')
      await asked.screen.press('\x04')
      const debug = asked.screen.text()
      expect(debug).not.toContain('Do you want to proceed?')
      expect(flat(debug)).toContain('PowerShell(Remove-Item:*)')
      expect(shown(debug).at(-1)).toBe('Ctrl-D to hide debug info')
      await asked.screen.press('\x04')
      expect(asked.screen.text()).toContain('Do you want to proceed?')
    },
    SLOW,
  )

  test(
    'without --debug, ctrl+d shows the details with no hint to hide them',
    async () => {
      const asked = await askPs('Get-Process')
      await asked.screen.press('\x04')
      expect(asked.screen.text()).not.toContain('Do you want to proceed?')
      expect(asked.screen.text()).not.toContain('Ctrl-D')
    },
    SLOW,
  )
})

describe('PowerShellPermissionRequest: what each answer reports', () => {
  const INPUT = { command: 'Remove-Item build' }
  const RULE = (content: string) => [allowRule('PowerShell', content)]
  type Row = { name: string; keys: string[]; calls: Call[]; escapes: number; argc?: number; managed?: boolean }
  const rows: Row[] = [
    { name: 'Enter on Yes: allow once, nothing saved, no note', keys: [enter], calls: allowed(INPUT, [], undefined), escapes: 0, argc: 3 },
    { name: 'Yes with a note: the note, trimmed', keys: [tab, ...typed(' and list it '), enter], calls: allowed(INPUT, [], 'and list it'), escapes: 0 },
    { name: '2: allow always with the command as typed, saved locally', keys: ['2'], calls: allowed(INPUT, RULE('Remove-Item build')), escapes: 0, argc: 2 },
    { name: 'the field edited to a prefix', keys: [down, ...erase(6), ...typed(':*'), enter], calls: allowed(INPUT, RULE('Remove-Item:*')), escapes: 0 },
    { name: 'the field edited with spaces around it: saved trimmed', keys: [down, ...typed('  '), enter], calls: allowed(INPUT, RULE('Remove-Item build')), escapes: 0 },
    { name: 'the field cleared: allow once, nothing saved', keys: [down, ...erase(20), enter], calls: allowed(INPUT, []), escapes: 0, argc: 2 },
    { name: '3: deny with no note, counted as an escape', keys: ['3'], calls: denied(), escapes: 1 },
    { name: 'No with a note: the note, trimmed, not counted', keys: [down, down, tab, ...typed(' keep it '), enter], calls: denied('keep it'), escapes: 0 },
    { name: 'Esc: deny, counted', keys: [esc], calls: denied(), escapes: 1 },
    { name: 'Esc with a Yes note written: the note is dropped', keys: [tab, ...typed('ok'), esc], calls: denied(), escapes: 1 },
    { name: 'y, n and a digit past the list: nothing', keys: ['y', 'n', '4'], calls: [], escapes: 0 },
    { name: 'managed policy: 2 is No', keys: ['2'], calls: denied(), escapes: 1, managed: true },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.managed) managedRulesOnly(world().home)
        const asked = await askPs('Remove-Item build')
        await settle()
        const calls = await answer(asked, row.keys)
        expect(calls).toEqual(row.calls)
        if (row.argc !== undefined) expect((calls[0] as { args: unknown[] }).args).toHaveLength(row.argc)
        expect(asked.screen.state().attribution.escapeCount).toBe(row.escapes)
      },
      SLOW,
    )
  }

  test(
    'the dialog tells the request about the user when focus moves or a note opens, not on first paint',
    async () => {
      let touches = 0
      const asked = await askPs('Get-Process', { confirm: { onUserInteraction: () => touches++ } })
      expect(touches).toBe(0)
      await asked.screen.press(down, down)
      expect(touches).toBe(2)
      await asked.screen.press(tab)
      expect(touches).toBe(3)
    },
    SLOW,
  )
})

describe('PowerShellPermissionRequest: the rule "don\'t ask again" saves', () => {
  test(
    'a multi-line command gets no field: the label names it, and the suggestions are saved as they came',
    async () => {
      const command = 'Get-ChildItem\nRemove-Item x'
      const asked = await askPs(command, { permissionResult: suggesting(psRule(command)) as never })
      await settle()
      expect(flat(asked.screen.text())).toContain(`2. Yes, and don't ask again for Get-ChildItem Remove-Item x commands in ${getOriginalCwd()}`)
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, [allowRule('PowerShell', command)]))
    },
    SLOW,
  )

  test(
    'a multi-line command with no suggestions: no allow-always option',
    async () => {
      const asked = await askPs('Get-ChildItem\nRemove-Item x', { permissionResult: { behavior: 'ask', message: 'asking' } })
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )

  test(
    'a directory among the suggestions: no field; a label naming the directory and the commands',
    async () => {
      const command = 'Set-Content C:\\out\\log.txt hi'
      const suggestions = [
        { type: 'addRules', rules: [psRule('Set-Content:*')], behavior: 'allow', destination: 'localSettings' },
        { type: 'addDirectories', directories: ['/srv/out'], destination: 'session' },
      ]
      const asked = await askPs(command, { permissionResult: { behavior: 'ask', message: 'asking', suggestions } as never })
      await settle()
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, and allow access to out/ and Set-Content commands')
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, suggestions))
    },
    SLOW,
  )

  test(
    'a Read rule among the suggestions: no field either',
    async () => {
      const command = 'Get-Content notes.md'
      const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '/srv/notes/**' }], behavior: 'allow', destination: 'session' }]
      const asked = await askPs(command, { permissionResult: { behavior: 'ask', message: 'asking', suggestions } as never })
      await settle()
      expect(optionLines(asked.screen.text())[1]).toBe('2. Yes, allow reading from notes/ from this project')
      expect(await answer(asked, ['2'])).toEqual(allowed({ command }, suggestions))
    },
    SLOW,
  )

  test(
    'suggestions that make no label: no allow-always option',
    async () => {
      const asked = await askPs('Get-Process', { permissionResult: { behavior: 'ask', message: 'asking', suggestions: [{ type: 'addDirectories', directories: [], destination: 'session' }] } as never })
      expect(optionLines(asked.screen.text())).toEqual(['❯ 1. Yes', '2. No'])
    },
    SLOW,
  )
})
