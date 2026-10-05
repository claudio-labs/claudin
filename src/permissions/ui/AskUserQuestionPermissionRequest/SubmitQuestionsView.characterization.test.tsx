/**
 * Characterization of the review step of the AskUserQuestion dialog, written
 * before the clean-base rewrite of permissions/askUserQuestion. The spec is
 * docs/tech/rewrite/permissions/askUserQuestion.md.
 *
 * Mounted on its own: the view reports only `'submit'` or `'cancel'`, and the
 * dialog turns those into the allow or the reject (pinned in the dialog's suite).
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import { SubmitQuestionsView } from 'src/permissions/ui/AskUserQuestionPermissionRequest/SubmitQuestionsView.js'
import { isolatedWorld, KEYS, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'
import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

isolatedWorld()
const { enter, esc, down } = KEYS

const asQuestion = (question: string, header: string): Question => ({
  question,
  header,
  multiSelect: false,
  options: [
    { label: 'one', description: 'the first' },
    { label: 'two', description: 'the second' },
  ],
})
const QUESTIONS = [asQuestion('Which region?', 'Region'), asQuestion('Which tier?', 'Tier'), asQuestion('Which zone?', 'Zone')]
const ASK: PermissionDecision = { behavior: 'ask', message: 'answer the questions' } as PermissionDecision

type View = { answers: Record<string, string>; all: boolean; permissionResult?: PermissionDecision; minContentHeight?: number; columns?: number }

async function review(view: View) {
  const responses: string[] = []
  const screen = await mount(
    <SubmitQuestionsView
      questions={QUESTIONS}
      currentQuestionIndex={QUESTIONS.length}
      answers={view.answers}
      allQuestionsAnswered={view.all}
      permissionResult={view.permissionResult ?? ASK}
      minContentHeight={view.minContentHeight}
      onFinalResponse={value => responses.push(value)}
    />,
    { columns: view.columns ?? 90 },
  )
  return { screen, responses }
}

describe('SubmitQuestionsView: what it shows', () => {
  test(
    'every question answered: the tabs, the heading, each question with its answer, and the two choices',
    async () => {
      const answers = { 'Which region?': 'one', 'Which tier?': 'two', 'Which zone?': 'one' }
      const { screen } = await review({ answers, all: true })
      expect(shown(screen.text())).toEqual([
        '─'.repeat(90),
        '←  ☒ Region  ☒ Tier  ☒ Zone  ✔ Submit  →',
        'Review your answers',
        '● Which region?',
        '→ one',
        '● Which tier?',
        '→ two',
        '● Which zone?',
        '→ one',
        'Ready to submit your answers?',
        '❯ 1. Submit answers',
        '2. Cancel',
      ])
    },
    SLOW,
  )

  test(
    'the answers are listed in question order, whatever order they were given in, and the indentation is kept',
    async () => {
      const answers = { 'Which zone?': 'one', 'Which region?': 'two' }
      const { screen } = await review({ answers, all: false })
      const lines = screen.text().split('\n').map(line => line.trimEnd())
      const start = lines.indexOf(' ● Which region?')
      expect(lines.slice(start, start + 4)).toEqual([' ● Which region?', '   → two', ' ● Which zone?', '   → one'])
    },
    SLOW,
  )

  type Warning = { name: string; view: View; warned: boolean; listed: string[] }
  const warnings: Warning[] = [
    { name: 'the warning follows the flag the dialog passes, not the answers', view: { answers: { 'Which region?': 'one', 'Which tier?': 'one', 'Which zone?': 'one' }, all: false }, warned: true, listed: ['Which region?', 'Which tier?', 'Which zone?'] },
    { name: 'answered all, with only some answers given: no warning, the given ones listed', view: { answers: { 'Which tier?': 'two' }, all: true }, warned: false, listed: ['Which tier?'] },
    { name: 'no answers: the warning and no list', view: { answers: {}, all: false }, warned: true, listed: [] },
    { name: 'answers only for questions that were not asked: nothing listed', view: { answers: { 'Which planet?': 'mars' }, all: false }, warned: true, listed: [] },
    { name: 'an empty answer is not listed', view: { answers: { 'Which region?': '' }, all: false }, warned: true, listed: [] },
  ]
  for (const w of warnings) {
    test(
      w.name,
      async () => {
        const { screen } = await review(w.view)
        const lines = shown(screen.text())
        expect(lines.includes('⚠ You have not answered all questions')).toBe(w.warned)
        expect(lines.filter(line => line.startsWith('● ')).map(line => line.slice(2))).toEqual(w.listed)
        expect(screen.text()).not.toContain('mars')
      },
      SLOW,
    )
  }

  test(
    'a rule that asked for confirmation is explained above the choices',
    async () => {
      const ruleValue = { toolName: 'AskUserQuestion' }
      const permissionResult = {
        behavior: 'ask',
        message: 'answer the questions',
        decisionReason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue } },
      } as unknown as PermissionDecision
      const { screen } = await review({ answers: {}, all: false, permissionResult })
      const lines = shown(screen.text())
      const at = lines.indexOf(`Permission rule ${permissionRuleValueToString(ruleValue)} requires confirmation for this tool.`)
      expect(at).toBeGreaterThan(0)
      expect(lines.slice(at + 1, at + 3)).toEqual(['/permissions to update rules', 'Ready to submit your answers?'])
    },
    SLOW,
  )

  test(
    'a minimum height pads the view below the choices',
    async () => {
      const plain = await review({ answers: {}, all: false })
      const plainHeight = plain.screen.text().trimEnd().split('\n').length
      await plain.screen.close()
      const padded = await review({ answers: {}, all: false, minContentHeight: 20 })
      const lines = padded.screen.text().split('\n')
      expect(shown(padded.screen.text())).toEqual(shown(plain.screen.text()))
      // The heading block is the divider, a blank, the tabs, a blank, the title: the padded part starts below it.
      const title = lines.findIndex(line => line.includes('Review your answers'))
      expect(lines.length - title - 1).toBeGreaterThanOrEqual(20)
      expect(plainHeight - title - 1).toBeLessThan(20)
    },
    SLOW,
  )
})

describe('SubmitQuestionsView: what it reports', () => {
  type Key = { name: string; keys: string[]; reported: string[] }
  const keys: Key[] = [
    { name: 'Enter on the pointed Submit', keys: [enter], reported: ['submit'] },
    { name: 'the digit 1', keys: ['1'], reported: ['submit'] },
    { name: 'Down, then Enter', keys: [down, enter], reported: ['cancel'] },
    { name: 'the digit 2', keys: ['2'], reported: ['cancel'] },
    { name: 'Esc', keys: [esc], reported: ['cancel'] },
    { name: 'a digit past the choices', keys: ['3'], reported: [] },
    { name: 'y and n', keys: ['y', 'n'], reported: [] },
  ]
  for (const k of keys) {
    test(
      `${k.name}: ${k.reported.length ? k.reported.join(', ') : 'nothing'}`,
      async () => {
        const { screen, responses } = await review({ answers: { 'Which region?': 'one' }, all: false })
        await screen.press(...k.keys)
        await Bun.sleep(100)
        expect(responses).toEqual(k.reported)
      },
      SLOW,
    )
  }
})
