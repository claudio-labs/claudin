/**
 * Characterization of the tab row above every AskUserQuestion view, written
 * before the clean-base rewrite of permissions/askUserQuestion. The spec is
 * docs/tech/rewrite/permissions/askUserQuestion.md.
 *
 * Mounted on its own, since the row is an export the question views and the
 * review share. Colours are compared with a reference `<Text>` drawn in the
 * same theme keys.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { QuestionNavigationBar } from 'src/permissions/ui/AskUserQuestionPermissionRequest/QuestionNavigationBar.js'
import { flat, isolatedWorld, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Text } from 'src/terminal/ink.js'
import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

isolatedWorld()
withTruecolor()

const asQuestion = (question: string, header: string): Question => ({
  question,
  header,
  multiSelect: false,
  options: [
    { label: 'yes', description: 'agree' },
    { label: 'no', description: 'disagree' },
  ],
})

const THREE = [asQuestion('Auth?', 'Authentication'), asQuestion('Engine?', 'Database engine'), asQuestion('Cache?', 'Caching')]

type Bar = { questions: Question[]; at: number; answers?: Record<string, string>; hideSubmitTab?: boolean; columns?: number }

async function bar({ questions, at, answers = {}, hideSubmitTab, columns = 120 }: Bar) {
  return mount(<QuestionNavigationBar questions={questions} currentQuestionIndex={at} answers={answers} hideSubmitTab={hideSubmitTab} />, { columns })
}

const row = (frame: string) => frame.split('\n')[0]!.trimEnd()

describe('QuestionNavigationBar: what the row reads', () => {
  type Case = { name: string; bar: Bar; row: string }
  const cases: Case[] = [
    { name: 'room for every header', bar: { questions: THREE, at: 1, answers: { 'Auth?': 'yes' } }, row: '←  ☒ Authentication  ☐ Database engine  ☐ Caching  ✔ Submit  →' },
    { name: 'an answer of an unknown question ticks nothing', bar: { questions: THREE, at: 0, answers: { 'Other?': 'yes' } }, row: '←  ☐ Authentication  ☐ Database engine  ☐ Caching  ✔ Submit  →' },
    { name: 'an empty answer does not tick', bar: { questions: THREE, at: 0, answers: { 'Auth?': '' } }, row: '←  ☐ Authentication  ☐ Database engine  ☐ Caching  ✔ Submit  →' },
    { name: 'the Submit tab can be left out', bar: { questions: THREE, at: 0, hideSubmitTab: true }, row: '←  ☐ Authentication  ☐ Database engine  ☐ Caching  →' },
    { name: 'one question and no Submit tab: no arrows either', bar: { questions: THREE.slice(0, 1), at: 0, hideSubmitTab: true }, row: ' ☐ Authentication' },
    { name: 'one question with a Submit tab keeps the arrows', bar: { questions: THREE.slice(0, 1), at: 0 }, row: '←  ☐ Authentication  ✔ Submit  →' },
    { name: 'an empty header is shown as Q and its position', bar: { questions: [asQuestion('A?', 'Alpha'), asQuestion('B?', '')], at: 0 }, row: '←  ☐ Alpha  ☐ Q2  ✔ Submit  →' },
    // 60 columns leave 46 for the tabs; the current tab keeps its header, the others share the rest.
    { name: 'too narrow: the other tabs are cut first', bar: { questions: THREE, at: 1, answers: { 'Auth?': 'yes' }, columns: 60 }, row: '←  ☒ Authenti…  ☐ Database engine  ☐ Caching  ✔ Submit  →' },
    // 40 columns: the current tab gets at most half of the 26 left, the others the floor of 6.
    { name: 'narrower: the current tab is cut too', bar: { questions: THREE, at: 1, answers: { 'Auth?': 'yes' }, columns: 40 }, row: '←  ☒ A…  ☐ Database…  ☐ C…  ✔ Submit  →' },
    { name: 'without the Submit tab the headers get its room', bar: { questions: THREE, at: 1, hideSubmitTab: true, columns: 50 }, row: '←  ☐ Authenti…  ☐ Database engine  ☐ Caching  →' },
    { name: 'the review position highlights no question', bar: { questions: THREE, at: 3, columns: 120 }, row: '←  ☐ Authentication  ☐ Database engine  ☐ Caching  ✔ Submit  →' },
  ]
  for (const c of cases) {
    test(
      c.name,
      async () => {
        const screen = await bar(c.bar)
        expect(row(screen.text())).toBe(c.row)
      },
      SLOW,
    )
  }
})

describe('QuestionNavigationBar: a terminal too narrow for any tab', () => {
  test(
    'the current header is cut to its first three characters',
    async () => {
      const screen = await bar({ questions: [asQuestion('Engine?', 'Database')], at: 0, hideSubmitTab: true, columns: 4 })
      expect(flat(screen.text())).toBe('☐ Dat')
    },
    SLOW,
  )

  test(
    'among several questions, only the current header is cut so',
    async () => {
      const screen = await bar({ questions: [asQuestion('Engine?', 'Database'), asQuestion('Cache?', 'Cache')], at: 0, columns: 14 })
      expect(flat(screen.text())).toContain('Dat')
      expect(screen.text()).not.toContain('Database')
    },
    SLOW,
  )

  test(
    'a tab with room for less than one character shows an ellipsis',
    async () => {
      const screen = await bar({ questions: [asQuestion('Engine?', 'Database')], at: 0, hideSubmitTab: true, columns: 14 })
      expect(row(screen.text())).toBe(' ☐ …')
    },
    SLOW,
  )
})

describe('QuestionNavigationBar: colours', () => {
  async function reference(node: React.ReactNode): Promise<string> {
    const screen = await mount(node)
    const style = styleBefore(screen.styled(), 'REF')
    await screen.close()
    return style
  }

  test(
    'the current tab is drawn on the permission colour in inverse text; the others are plain',
    async () => {
      const current = await reference(
        <Text backgroundColor="permission" color="inverseText">
          REF
        </Text>,
      )
      const screen = await bar({ questions: THREE, at: 1 })
      expect(styleBefore(screen.styled(), ' ☐ Database engine ')).toBe(current)
      expect(styleBefore(screen.styled(), ' ☐ Caching ')).not.toBe(current)
    },
    SLOW,
  )

  test(
    'on the review position the Submit tab is the highlighted one',
    async () => {
      const current = await reference(
        <Text backgroundColor="permission" color="inverseText">
          REF
        </Text>,
      )
      const atReview = await bar({ questions: THREE, at: 3 })
      expect(styleBefore(atReview.styled(), ' ✔ Submit ')).toBe(current)
      await atReview.close()
      const onQuestion = await bar({ questions: THREE, at: 0 })
      expect(styleBefore(onQuestion.styled(), ' ✔ Submit ')).not.toBe(current)
    },
    SLOW,
  )

  test(
    'the left arrow is dimmed on the first tab and the right arrow on the review',
    async () => {
      const inactive = await reference(<Text color="inactive">REF</Text>)
      const first = await bar({ questions: THREE, at: 0 })
      // A highlighted tab before an arrow leaves a background reset in front of the arrow's own colour.
      expect(styleBefore(first.styled(), '←').endsWith(inactive)).toBe(true)
      expect(styleBefore(first.styled(), ' →')).not.toContain(inactive)
      await first.close()
      const review = await bar({ questions: THREE, at: 3 })
      expect(styleBefore(review.styled(), ' →').endsWith(inactive)).toBe(true)
      expect(styleBefore(review.styled(), '←')).not.toContain(inactive)
    },
    SLOW,
  )
})
