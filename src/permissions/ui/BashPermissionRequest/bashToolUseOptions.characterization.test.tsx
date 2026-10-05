/**
 * Characterization of the option lists the two shell dialogs hand to their
 * `Select`: `bashToolUseOptions` and `powershellToolUseOptions`. Written
 * before the clean-base rewrite of permissions/shellDialogs; the spec is
 * docs/tech/rewrite/permissions/shellDialogs.md.
 *
 * Both builders are called directly. The option objects carry callbacks, so
 * each one is read back as its plain fields plus whether the callback given
 * is the one wired in.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import { bashToolUseOptions } from 'src/permissions/ui/BashPermissionRequest/bashToolUseOptions.js'
import { powershellToolUseOptions } from 'src/permissions/ui/PowerShellPermissionRequest/powershellToolUseOptions.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { Text } from 'src/terminal/ink.js'
import { flat, isolatedWorld, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { managedRulesOnly } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()

const onReject = (_: string) => {}
const onAccept = (_: string) => {}
const onPrefix = (_: string) => {}
const CALLBACKS = new Map<unknown, string>([
  [onReject, 'reject note'],
  [onAccept, 'accept note'],
  [onPrefix, 'prefix'],
])

/** An option as data: its fields, with the callback named and a node label marked. */
function plain(option: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(option)) {
    if (typeof value === 'function') out[key] = CALLBACKS.get(value) ?? 'another function'
    else if (key === 'label' && typeof value !== 'string') out[key] = '<node>'
    else out[key] = value
  }
  return out
}

const rules = (toolName: string, ...contents: string[]): PermissionUpdate =>
  ({ type: 'addRules', rules: contents.map(ruleContent => ({ toolName, ruleContent })), behavior: 'allow', destination: 'localSettings' }) as PermissionUpdate
const dirs = (...directories: string[]): PermissionUpdate => ({ type: 'addDirectories', directories, destination: 'session' }) as PermissionUpdate

const YES = { label: 'Yes', value: 'yes' }
const NO = { label: 'No', value: 'no' }
const YES_NOTE = { type: 'input', label: 'Yes', value: 'yes', placeholder: 'and tell Claude what to do next', onChange: 'accept note', allowEmptySubmitToCancel: true }
const NO_NOTE = { type: 'input', label: 'No', value: 'no', placeholder: 'and tell Claude what to do differently', onChange: 'reject note', allowEmptySubmitToCancel: true }
/** Drawn as "<label>: <value>", the cursor going back to the end on each change. */
const DRAWN_AS_LABEL_COLON_VALUE = { resetCursorOnUpdate: true, labelValueSeparator: ': ', showLabelWithValue: true }
/** The editable allow-always field; key order is irrelevant to toEqual. */
const field = (initialValue: string, example: string) => ({
  value: 'yes-prefix-edited',
  type: 'input',
  label: 'Yes, and don’t ask again for',
  ...DRAWN_AS_LABEL_COLON_VALUE,
  initialValue,
  onChange: 'prefix',
  placeholder: `command prefix (e.g., ${example})`,
  allowEmptySubmitToCancel: true,
})
const LABEL = { label: '<node>', value: 'yes-apply-suggestions' }

type Args = {
  suggestions?: PermissionUpdate[]
  yesInputMode?: boolean
  noInputMode?: boolean
  editablePrefix?: string
  onEditablePrefixChange?: (value: string) => void
}
type Row = { name: string; args: Args; bash: unknown[]; ps: unknown[] }

const rows: Row[] = [
  { name: 'nothing to suggest', args: {}, bash: [YES, NO], ps: [YES, NO] },
  { name: 'notes open on both', args: { yesInputMode: true, noInputMode: true }, bash: [YES_NOTE, NO_NOTE], ps: [YES_NOTE, NO_NOTE] },
  {
    name: 'both shells\' rules and a field: the label, since each sees the other\'s rule as foreign',
    args: { suggestions: [rules('Bash', 'x:*'), rules('PowerShell', 'x:*')], editablePrefix: 'npm run:*', onEditablePrefixChange: onPrefix },
    bash: [YES, LABEL, NO],
    ps: [YES, LABEL, NO],
  },
  { name: 'a field with no suggestions: no allow-always option', args: { editablePrefix: 'npm run:*', onEditablePrefixChange: onPrefix }, bash: [YES, NO], ps: [YES, NO] },
  {
    name: 'a field value with no callback to edit it: the label instead',
    args: { suggestions: [rules('Bash', 'make:*'), rules('PowerShell', 'Get-Item:*')], editablePrefix: 'make:*' },
    bash: [YES, LABEL, NO],
    ps: [YES, LABEL, NO],
  },
  {
    name: 'a directory among the suggestions: the label instead of the field',
    args: { suggestions: [rules('Bash', 'make:*'), rules('PowerShell', 'Get-Item:*'), dirs('/srv/out')], editablePrefix: 'make:*', onEditablePrefixChange: onPrefix },
    bash: [YES, LABEL, NO],
    ps: [YES, LABEL, NO],
  },
  {
    name: 'suggestions that make no label: no allow-always option',
    args: { suggestions: [dirs()] },
    bash: [YES, NO],
    ps: [YES, NO],
  },
]

describe('the option lists', () => {
  for (const row of rows) {
    test(`Bash: ${row.name}`, () => {
      const options = bashToolUseOptions({ ...row.args, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      expect(options.map(o => plain(o as never))).toEqual(row.bash as never)
    })
    test(`PowerShell: ${row.name}`, () => {
      const options = powershellToolUseOptions({ ...row.args, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      expect(options.map(o => plain(o as never))).toEqual(row.ps as never)
    })
  }

  test('Bash: its own rules and a field give the field, seeded with the value; an empty value still counts', () => {
    for (const value of ['npm run:*', '']) {
      const options = bashToolUseOptions({ suggestions: [rules('Bash', 'npm run test')], editablePrefix: value, onEditablePrefixChange: onPrefix, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      expect(options.map(o => plain(o as never))).toEqual([YES, field(value, 'npm run:*'), NO] as never)
    }
  })

  test('PowerShell: its own rules and a field give the field, seeded with the value', () => {
    const options = powershellToolUseOptions({ suggestions: [rules('PowerShell', 'Get-Process')], editablePrefix: 'Get-Process', onEditablePrefixChange: onPrefix, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
    expect(options.map(o => plain(o as never))).toEqual([YES, field('Get-Process', 'Get-Process:*'), NO] as never)
  })

  test('Bash: the classifier inputs change nothing', () => {
    const options = bashToolUseOptions({
      suggestions: [rules('Bash', 'npm test:*')],
      editablePrefix: 'npm test:*',
      onEditablePrefixChange: onPrefix,
      onRejectFeedbackChange: onReject,
      onAcceptFeedbackChange: onAccept,
      onClassifierDescriptionChange: () => {},
      classifierDescription: 'run the tests',
      initialClassifierDescriptionEmpty: false,
      existingAllowDescriptions: ['deploy'],
      decisionReason: { type: 'other', reason: 'x' },
    })
    expect(options.map(o => o.value)).toEqual(['yes', 'yes-prefix-edited', 'no'])
  })

  test('managed policy keeps rules to itself: Yes and No only, notes still offered', () => {
    managedRulesOnly(world().home)
    const args = { suggestions: [rules('Bash', 'make:*'), rules('PowerShell', 'Get-Item:*')], editablePrefix: 'make:*', onEditablePrefixChange: onPrefix, yesInputMode: true, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept }
    expect(bashToolUseOptions(args).map(o => plain(o as never))).toEqual([YES_NOTE, NO] as never)
    expect(powershellToolUseOptions(args).map(o => plain(o as never))).toEqual([YES_NOTE, NO] as never)
  })
})

describe('the label each shell gives its suggestions', () => {
  async function labelText(label: React.ReactNode): Promise<string> {
    const screen = await mount(<Text>{label}</Text>, { columns: 300 })
    const text = flat(screen.text())
    await screen.close()
    return text
  }

  test(
    'Bash leaves stdout redirections out of the command names (not stderr ones); PowerShell keeps them',
    async () => {
      const bashSuggestions = [rules('Bash', 'cat a > out.txt', 'ls 2> err.log'), dirs('/srv/out')]
      const psSuggestions = [rules('PowerShell', 'Get-Item a > out.txt'), dirs('/srv/out')]
      const bash = bashToolUseOptions({ suggestions: bashSuggestions, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      const ps = powershellToolUseOptions({ suggestions: psSuggestions, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      expect(await labelText(bash[1]!.label)).toBe('Yes, and allow out/ access and cat a and ls 2> err.log commands')
      expect(await labelText(ps[1]!.label)).toBe('Yes, and allow access to out/ and Get-Item a > out.txt commands')
    },
    SLOW,
  )

  test(
    'each shell names only its own commands',
    async () => {
      const both = [rules('Bash', 'make:*'), rules('PowerShell', 'Get-Item:*')]
      const bash = bashToolUseOptions({ suggestions: both, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      const ps = powershellToolUseOptions({ suggestions: both, onRejectFeedbackChange: onReject, onAcceptFeedbackChange: onAccept })
      expect(await labelText(bash[1]!.label)).toBe(`Yes, and don't ask again for make commands in ${getOriginalCwd()}`)
      expect(await labelText(ps[1]!.label)).toBe(`Yes, and don't ask again for Get-Item commands in ${getOriginalCwd()}`)
    },
    SLOW,
  )
})
