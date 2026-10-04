/**
 * The findings of docs/tech/rewrite/permissions/promptFrame.md that the
 * rewrite fixes, and the answer model PermissionPrompt is built on. The
 * characterization suites pin everything kept for parity; this file pins
 * what changed on purpose.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { clearDynamicTeamContext, setDynamicTeamContext } from 'src/agent/coordinator/teammate.js'
import * as hooksModule from 'src/permissions/ui/hooks.js'
import { usePermissionRequestLogging, type UnaryEvent } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from 'src/permissions/ui/PermissionPrompt.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRequestTitle } from 'src/permissions/ui/PermissionRequestTitle.js'
import {
  answerWith,
  boundOptionFor,
  hintFor,
  initialPromptState,
  isListKey,
  isNoteOpen,
  type PromptEvent,
  type PromptState,
  reducePrompt,
} from 'src/permissions/ui/prompt/answerModel.js'
import { WorkerPendingPermission } from 'src/permissions/ui/WorkerPendingPermission.js'
import { flat, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import type { Key } from 'src/terminal/ink.js'
import { Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const { enter, tab, down } = KEYS

type Answer = ['picked', string, string | undefined] | ['cancelled']

// --- the answer model, without Ink ---------------------------------------------------

describe('the answer model', () => {
  const OPTIONS: PermissionPromptOption<string>[] = [
    { value: 'once', label: 'Yes', feedbackConfig: { type: 'accept' } },
    { value: 'always', label: 'Yes, always' },
    { value: 'refuse', label: 'No', feedbackConfig: { type: 'reject' } },
  ]
  const run = (events: PromptEvent<string>[]): PromptState<string> =>
    events.reduce((state, event) => reducePrompt(state, event, OPTIONS), initialPromptState(OPTIONS))

  type Row = { name: string; events: PromptEvent<string>[]; choose: string; note: string | undefined }
  const rows: Row[] = [
    { name: 'no note was opened', events: [], choose: 'once', note: undefined },
    { name: 'an open note is reported trimmed', events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: '  soon ' }], choose: 'once', note: 'soon' },
    { name: 'a blank note is no note', events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: '   ' }], choose: 'once', note: undefined },
    { name: 'a closed note is not reported', events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: 'x' }, { type: 'toggleNote', value: 'once' }], choose: 'once', note: undefined },
    { name: 'the accept note never rides on a deny', events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: 'x' }], choose: 'refuse', note: undefined },
    { name: 'the reject note never rides on an allow', events: [{ type: 'point', value: 'refuse' }, { type: 'toggleNote', value: 'refuse' }, { type: 'writeNote', kind: 'reject', text: 'no' }], choose: 'once', note: undefined },
    { name: 'the reject note rides on its deny', events: [{ type: 'point', value: 'refuse' }, { type: 'toggleNote', value: 'refuse' }, { type: 'writeNote', kind: 'reject', text: 'no' }], choose: 'refuse', note: 'no' },
    { name: 'an option without a note reports none', events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: 'x' }], choose: 'always', note: undefined },
    {
      name: 'a written note survives the pointer leaving it',
      events: [{ type: 'toggleNote', value: 'once' }, { type: 'writeNote', kind: 'accept', text: 'x' }, { type: 'point', value: 'always' }],
      choose: 'once',
      note: 'x',
    },
  ]
  for (const row of rows) {
    test(row.name, () => {
      expect(answerWith(run(row.events), OPTIONS, row.choose)).toEqual({ type: 'select', value: row.choose, note: row.note })
    })
  }

  test('the pointer leaving an empty note closes it; Tab on an option without a note changes nothing', () => {
    const opened = run([{ type: 'toggleNote', value: 'once' }])
    expect(isNoteOpen(opened, OPTIONS, 'once')).toBe(true)
    expect(isNoteOpen(reducePrompt(opened, { type: 'point', value: 'always' }, OPTIONS), OPTIONS, 'once')).toBe(false)
    // Moving onto an option of the same kind keeps it open.
    const twoAccepts: PermissionPromptOption<string>[] = [OPTIONS[0]!, { value: 'again', label: 'Again', feedbackConfig: { type: 'accept' } }]
    const open = reducePrompt(initialPromptState(twoAccepts), { type: 'toggleNote', value: 'once' }, twoAccepts)
    expect(isNoteOpen(reducePrompt(open, { type: 'point', value: 'again' }, twoAccepts), twoAccepts, 'again')).toBe(true)
    const state = run([])
    expect(reducePrompt(state, { type: 'toggleNote', value: 'always' }, OPTIONS)).toBe(state)
  })

  test('the hint offers Tab only on an option that takes a note whose note is closed', () => {
    expect(hintFor(run([]), OPTIONS)).toBe('Esc to cancel · Tab to amend')
    expect(hintFor(run([{ type: 'toggleNote', value: 'once' }]), OPTIONS)).toBe('Esc to cancel')
    expect(hintFor(run([{ type: 'point', value: 'always' }]), OPTIONS)).toBe('Esc to cancel')
  })

  test('a bound option is found by its action', () => {
    const bound: PermissionPromptOption<string>[] = [{ value: 'a', label: 'A', keybinding: 'confirm:yes' }, { value: 'b', label: 'B' }]
    expect(boundOptionFor(bound, 'confirm:yes')?.value).toBe('a')
    expect(boundOptionFor(bound, 'confirm:no')).toBeUndefined()
  })
})

// --- Finding 1: a bound action never answers through a list key ---------------------------

describe('Finding 1: an option binding never shadows a key the list uses', () => {
  const none: Key = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
    home: false, end: false, return: false, escape: false, ctrl: false, shift: false, fn: false, tab: false, backspace: false, delete: false,
    meta: false, super: false,
  }
  const keys: Array<[string, string, Partial<Key>, boolean]> = [
    ['Enter', '', { return: true }, true],
    ['Esc', '', { escape: true }, true],
    ['Tab', '', { tab: true }, true],
    ['Up', '', { upArrow: true }, true],
    ['Down', '', { downArrow: true }, true],
    ['PgUp', '', { pageUp: true }, true],
    ['PgDn', '', { pageDown: true }, true],
    ['space', ' ', {}, true],
    ['a digit', '7', {}, true],
    ['a full-width digit', '３', {}, true],
    ['y', 'y', {}, false],
    ['n', 'n', {}, false],
    ['Ctrl+E', 'e', { ctrl: true }, false],
  ]
  for (const [name, input, flags, list] of keys) {
    test(`${name} ${list ? 'is' : 'is not'} a list key`, () => {
      expect(isListKey(input, { ...none, ...flags })).toBe(list)
    })
  }

  async function prompt(options: PermissionPromptOption<string>[]) {
    const answers: Answer[] = []
    const screen = await mount(
      <PermissionPrompt options={options} onSelect={(value, note) => answers.push(['picked', value, note])} onCancel={() => answers.push(['cancelled'])} />,
    )
    return { screen, answers }
  }

  test(
    'Enter answers the option under the pointer, not the one bound to confirm:yes',
    async () => {
      const { screen, answers } = await prompt([
        { value: 'yes', label: 'Yes', keybinding: 'confirm:yes' },
        { value: 'no', label: 'No' },
      ])
      await screen.press(down, enter)
      expect(answers).toEqual([['picked', 'no', undefined]])
    },
    SLOW,
  )

  const listKeys: Array<[string, string, PermissionPromptOption<string>['keybinding']]> = [
    ['space', ' ', 'confirm:toggle'],
    ['Tab', tab, 'confirm:nextField'],
  ]
  for (const [name, keyPress, action] of listKeys) {
    test(
      `${name}, bound to ${action} by default, does not answer for an option bound to it`,
      async () => {
        const { screen, answers } = await prompt([
          { value: 'stay', label: 'Stay' },
          { value: 'bound', label: 'Bound', keybinding: action },
        ])
        await screen.press(keyPress)
        expect(answers).toEqual([])
        await screen.press(enter)
        expect(answers).toEqual([['picked', 'stay', undefined]])
      },
      SLOW,
    )
  }

  test(
    'while a note is being typed, the letters of a bound key are text',
    async () => {
      const { screen, answers } = await prompt([
        { value: 'allow', label: 'Allow', keybinding: 'confirm:yes' },
        { value: 'deny', label: 'Deny', feedbackConfig: { type: 'reject' } },
      ])
      await screen.press(down, tab, 'y', 'e', 's', enter)
      expect(answers).toEqual([['picked', 'deny', 'yes']])
    },
    SLOW,
  )
})

// --- Findings 2 and 3: one logical line per <Text> at narrow widths ------------------------

describe('Findings 2 and 3: lines stay whole at narrow widths', () => {
  afterEach(() => clearDynamicTeamContext())

  const TITLE = 'A fairly long permission title'

  for (const columns of [80, 40, 28]) {
    test(`at ${columns} columns the title and the badge read as one sentence, and the right part stays whole on the first row`, async () => {
      const lines = (
        await renderToString(
          <PermissionDialog title={TITLE} workerBadge={{ name: 'researcher', color: 'blue' }} titleRight={<Text>RIGHT</Text>}>
            <Text>body</Text>
          </PermissionDialog>,
          columns,
        )
      ).split('\n')
      const titleRows = lines.slice(2, lines.indexOf(' body'))
      expect(titleRows[0]!.trimEnd().endsWith(' RIGHT')).toBe(true)
      const left = titleRows.map((row, index) => (index === 0 ? row.trimEnd().slice(0, -'RIGHT'.length) : row))
      expect(flat(left.join('\n'))).toBe(`${TITLE} · @researcher`)
    })

    test(`at ${columns} columns the title block on its own keeps title and badge in one paragraph`, async () => {
      const out = await renderToString(<PermissionRequestTitle title={TITLE} workerBadge={{ name: 'researcher', color: 'blue' }} subtitle="sub" />, columns)
      expect(flat(out)).toBe(`${TITLE} · @researcher sub`)
    })
  }

  for (const columns of [80, 44, 30]) {
    test(`at ${columns} columns the worker card keeps each label with its value, in order`, async () => {
      setDynamicTeamContext({ agentId: 'builder@alpha', agentName: 'builder', teamName: 'alpha', planModeRequired: false, color: 'green' })
      const description = 'rebuild the search index for every tenant'
      const out = await renderToString(
        <AppStateProvider>
          <WorkerPendingPermission toolName="Bash" description={description} />
        </AppStateProvider>,
        columns,
      )
      const inside = out
        .split('\n')
        .slice(1, -1)
        .map(line => line.replace(/^│/, '').replace(/│\s*$/, ''))
        .join('\n')
      expect(flat(inside)).toMatch(
        new RegExp(`^\\S+ Waiting for team lead approval ● @builder Tool: Bash Action: ${description} Permission request sent to team "alpha" leader$`),
      )
    })
  }
})

// --- Finding 6: the counter is all that is left of hooks.ts ------------------------------

describe('Finding 6: usePermissionRequestLogging only counts', () => {
  test('the module exports the hook and nothing else', () => {
    expect(Object.keys(hooksModule)).toEqual(['usePermissionRequestLogging'])
  })

  test(
    'the event argument is never read',
    async () => {
      const unread = new Proxy({} as UnaryEvent, {
        get() {
          throw new Error('the event was read')
        },
      })
      const confirm = { toolUseID: 'toolu_unread' } as ToolUseConfirm
      function Probe(): React.ReactNode {
        usePermissionRequestLogging(confirm, unread)
        return <Text>counted</Text>
      }
      const screen = await mount(<Probe />)
      expect(screen.text()).toContain('counted')
      expect(screen.state().attribution.permissionPromptCount).toBe(1)
    },
    SLOW,
  )
})
