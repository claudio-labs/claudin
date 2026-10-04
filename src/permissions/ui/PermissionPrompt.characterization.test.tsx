/**
 * Characterization of PermissionPrompt, the question-and-options block most
 * permission dialogs end with: what it shows, which key answers what, the
 * optional feedback line, and what it reports to its caller. Written before
 * the clean-base rewrite of permissions/promptFrame; the spec is
 * docs/tech/rewrite/permissions/promptFrame.md.
 *
 * The answers are the security surface: every path is checked both for the
 * answer it gives and for the answers it must not give.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { PermissionPrompt, type PermissionPromptOption } from 'src/permissions/ui/PermissionPrompt.js'
import { Text } from 'src/terminal/ink.js'
import { flat, KEYS, linesOf, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

const { enter, esc, tab, up, down } = KEYS

type Answer = ['picked', string, string | undefined] | ['cancelled']

/** The three-way choice the tool dialogs offer: yes (with a note), yes always, no (with a note). */
const THREE: PermissionPromptOption<string>[] = [
  { value: 'once', label: 'Yes', feedbackConfig: { type: 'accept' } },
  { value: 'always', label: 'Yes, and remember it' },
  { value: 'refuse', label: 'No', feedbackConfig: { type: 'reject' } },
]

async function prompt(
  options: PermissionPromptOption<string>[] = THREE,
  extra: { question?: React.ReactNode; noCancel?: boolean; columns?: number } = {},
) {
  const answers: Answer[] = []
  const screen = await mount(
    <PermissionPrompt
      options={options}
      question={extra.question as string | undefined}
      onSelect={(value, feedback) => answers.push(['picked', value, feedback])}
      onCancel={extra.noCancel ? undefined : () => answers.push(['cancelled'])}
    />,
    { columns: extra.columns },
  )
  return { screen, answers }
}

/** The row that carries the ❯ pointer, without the pointer. */
const pointed = (frame: string) =>
  linesOf(frame)
    .find(line => line.trimStart().startsWith('❯'))
    ?.replace(/^\s*❯\s*/, '')

describe('PermissionPrompt: what it shows', () => {
  test(
    'the question, the numbered options with the first one pointed at, a blank line, then the key hints',
    async () => {
      const { screen } = await prompt()
      const rows = linesOf(screen.text()).map(line => line.trim())
      expect(rows).toEqual(['Do you want to proceed?', '❯ 1. Yes', '2. Yes, and remember it', '3. No', '', 'Esc to cancel · Tab to amend'])
    },
    SLOW,
  )

  test(
    'a question given as a string replaces the default one, and one given as an element is drawn as it is',
    async () => {
      const asText = await prompt(THREE, { question: 'Shall I go ahead?' })
      expect(linesOf(asText.screen.text())[0]!.trim()).toBe('Shall I go ahead?')
      expect(asText.screen.text()).not.toContain('Do you want to proceed?')
      await asText.screen.close()

      const asNode = await prompt(THREE, { question: <Text>Allow the deploy to staging?</Text> })
      expect(linesOf(asNode.screen.text())[0]!.trim()).toBe('Allow the deploy to staging?')
    },
    SLOW,
  )

  const hints: Array<{ name: string; keys: string[]; options?: PermissionPromptOption<string>[]; hint: string }> = [
    { name: 'the pointed option takes a note', keys: [], hint: 'Esc to cancel · Tab to amend' },
    { name: 'the pointed option takes no note', keys: [down], hint: 'Esc to cancel' },
    { name: 'the deny option takes a note too', keys: [down, down], hint: 'Esc to cancel · Tab to amend' },
    { name: 'its note line is already open', keys: [tab], hint: 'Esc to cancel' },
    {
      name: 'no option takes a note',
      keys: [],
      options: [
        { value: 'a', label: 'Allow' },
        { value: 'b', label: 'Deny' },
      ],
      hint: 'Esc to cancel',
    },
  ]
  for (const row of hints) {
    test(
      `the last line: ${row.name}`,
      async () => {
        const { screen } = await prompt(row.options)
        await screen.press(...row.keys)
        expect(linesOf(screen.text()).at(-1)!.trim()).toBe(row.hint)
      },
      SLOW,
    )
  }

  for (const columns of [80, 34, 22]) {
    test(
      `at ${columns} columns the hint stays one sentence in order`,
      async () => {
        const { screen } = await prompt(THREE, { columns })
        expect(flat(screen.text())).toContain('Esc to cancel · Tab to amend')
      },
      SLOW,
    )
  }
})

describe('PermissionPrompt: the answer each key gives', () => {
  type Row = { name: string; keys: string[]; answers: Answer[]; escapes?: number }
  const rows: Row[] = [
    { name: 'Enter answers with the pointed option', keys: [enter], answers: [['picked', 'once', undefined]] },
    { name: 'Down then Enter answers with the next one', keys: [down, enter], answers: [['picked', 'always', undefined]] },
    { name: 'Down twice then Enter answers no', keys: [down, down, enter], answers: [['picked', 'refuse', undefined]] },
    { name: 'Up from the first option wraps to the last', keys: [up, enter], answers: [['picked', 'refuse', undefined]] },
    { name: 'a digit answers with that option at once', keys: ['2'], answers: [['picked', 'always', undefined]] },
    { name: 'the digit of a deny option denies at once', keys: ['3'], answers: [['picked', 'refuse', undefined]] },
    { name: 'a digit past the last option does nothing', keys: ['9'], answers: [] },
    { name: 'y does not answer yes', keys: ['y'], answers: [] },
    { name: 'n does not answer no', keys: ['n'], answers: [] },
    { name: 'Ctrl+C is not handled here', keys: [KEYS.ctrlC], answers: [] },
    { name: 'Esc cancels, and counts one escape', keys: [esc], answers: [['cancelled']], escapes: 1 },
    { name: 'Esc while a note is open cancels too', keys: [tab, 'w', 'a', 'i', 't', esc], answers: [['cancelled']], escapes: 1 },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const { screen, answers } = await prompt()
        await screen.press(...row.keys)
        expect(answers).toEqual(row.answers)
        expect(screen.state().attribution.escapeCount).toBe(row.escapes ?? 0)
      },
      SLOW,
    )
  }

  test(
    'Esc with no cancel handler still counts the escape and answers nothing',
    async () => {
      const { screen, answers } = await prompt(THREE, { noCancel: true })
      await screen.press(esc)
      expect(answers).toEqual([])
      expect(screen.state().attribution.escapeCount).toBe(1)
    },
    SLOW,
  )
})

describe('PermissionPrompt: the note (Tab to amend)', () => {
  test(
    'Tab opens a note line on the pointed option with its default prompt, and Tab again closes it',
    async () => {
      const { screen, answers } = await prompt()
      await screen.press(tab)
      expect(pointed(screen.text())).toBe('1. Yes, tell Claude what to do next')
      await screen.press(tab)
      expect(pointed(screen.text())).toBe('1. Yes')
      await screen.press(down, down, tab)
      expect(pointed(screen.text())).toBe('3. No, tell Claude what to do differently')
      expect(answers).toEqual([])
    },
    SLOW,
  )

  test(
    'an option may bring its own prompt for the note',
    async () => {
      const { screen } = await prompt([
        { value: 'go', label: 'Go', feedbackConfig: { type: 'accept', placeholder: 'anything to add?' } },
        { value: 'stop', label: 'Stop', feedbackConfig: { type: 'reject', placeholder: 'what went wrong?' } },
      ])
      await screen.press(tab)
      expect(pointed(screen.text())).toBe('1. Go, anything to add?')
      await screen.press(down, tab)
      expect(pointed(screen.text())).toBe('2. Stop, what went wrong?')
    },
    SLOW,
  )

  test(
    'Tab on an option that takes no note opens nothing',
    async () => {
      const { screen, answers } = await prompt()
      await screen.press(down, tab)
      expect(pointed(screen.text())).toBe('2. Yes, and remember it')
      await screen.press(enter)
      expect(answers).toEqual([['picked', 'always', undefined]])
    },
    SLOW,
  )

  type Row = { name: string; keys: string[]; answers: Answer[] }
  const rows: Row[] = [
    { name: 'a note on yes travels with the yes, trimmed', keys: [tab, ' ', 'o', 'k', ' ', enter], answers: [['picked', 'once', 'ok']] },
    { name: 'a note on no travels with the no', keys: [down, down, tab, 'n', 'o', 'p', 'e', enter], answers: [['picked', 'refuse', 'nope']] },
    { name: 'an empty note still answers, with no note', keys: [tab, enter], answers: [['picked', 'once', undefined]] },
    { name: 'an empty note on no still denies, and does not cancel', keys: [down, down, tab, enter], answers: [['picked', 'refuse', undefined]] },
    { name: 'a note of spaces counts as no note', keys: [tab, ' ', ' ', enter], answers: [['picked', 'once', undefined]] },
    { name: 'digits typed in a note are text, not answers', keys: [tab, '3', enter], answers: [['picked', 'once', '3']] },
    {
      name: 'the yes note never rides on a no',
      keys: [tab, 'l', 'g', 't', 'm', down, down, enter],
      answers: [['picked', 'refuse', undefined]],
    },
    {
      name: 'the no note never rides on a yes',
      keys: [down, down, tab, 'n', 'o', up, up, enter],
      answers: [['picked', 'once', undefined]],
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        const { screen, answers } = await prompt()
        await screen.press(...row.keys)
        expect(answers).toEqual(row.answers)
      },
      SLOW,
    )
  }

  test(
    'leaving an empty note closes it; leaving a written one keeps it, and it answers when its option is chosen again',
    async () => {
      const empty = await prompt()
      await empty.screen.press(tab, down)
      expect(linesOf(empty.screen.text()).map(line => line.trim())).toContain('1. Yes')
      expect(linesOf(empty.screen.text()).at(-1)!.trim()).toBe('Esc to cancel')
      // Back on it, the option is closed again: plain label, and Tab offered.
      await empty.screen.press(up)
      expect(pointed(empty.screen.text())).toBe('1. Yes')
      expect(linesOf(empty.screen.text()).at(-1)!.trim()).toBe('Esc to cancel · Tab to amend')
      await empty.screen.close()

      const written = await prompt()
      await written.screen.press(tab, 'x', down)
      expect(linesOf(written.screen.text()).map(line => line.trim())).toContain('1. Yes, x')
      await written.screen.press(up, enter)
      expect(written.answers).toEqual([['picked', 'once', 'x']])
    },
    SLOW,
  )
})

describe('PermissionPrompt: an option with its own key binding', () => {
  test(
    'the bound action answers with that option, whatever is pointed at',
    async () => {
      const { screen, answers } = await prompt([
        { value: 'allow', label: 'Allow', keybinding: 'confirm:yes' },
        { value: 'deny', label: 'Deny', keybinding: 'confirm:no' },
        { value: 'later', label: 'Later' },
      ])
      await screen.press(down, down, 'y')
      expect(answers).toEqual([['picked', 'allow', undefined]])
      await screen.press('n')
      expect(answers).toEqual([
        ['picked', 'allow', undefined],
        ['picked', 'deny', undefined],
      ])
    },
    SLOW,
  )

  test(
    'Esc still cancels when an option is bound to the no action',
    async () => {
      const { screen, answers } = await prompt([
        { value: 'allow', label: 'Allow' },
        { value: 'deny', label: 'Deny', keybinding: 'confirm:no' },
      ])
      await screen.press(esc)
      expect(answers).toEqual([['cancelled']])
    },
    SLOW,
  )

  test(
    'without bound options, y, n and Enter answer only through the pointed option',
    async () => {
      const { screen, answers } = await prompt([
        { value: 'allow', label: 'Allow' },
        { value: 'deny', label: 'Deny' },
      ])
      await screen.press('y', 'n', down, enter)
      expect(answers).toEqual([['picked', 'deny', undefined]])
    },
    SLOW,
  )
})
