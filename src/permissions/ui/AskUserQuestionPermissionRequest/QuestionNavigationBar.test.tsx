import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { QuestionNavigationBar } from 'src/permissions/ui/AskUserQuestionPermissionRequest/QuestionNavigationBar.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import type { Question } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'

const ANSWERED = '\u{f0134}'
const UNANSWERED = '\u{f0130}'
const PUA_RE = /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}]/u

const options = [
  { label: 'Yes', description: 'Do it' },
  { label: 'No', description: 'Leave it' },
]
const questions = [
  { question: 'Which fixes?', header: 'Limpezas', options, multiSelect: true },
  { question: 'What about spinnerVerbs?', header: 'spinnerVerbs', options, multiSelect: false },
] as Question[]

let saved: string | undefined
beforeAll(() => {
  saved = process.env.CLAUDIN_NERD_FONT
})
afterAll(() => {
  if (saved === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = saved
})

async function renderBar(nerd: boolean): Promise<string> {
  process.env.CLAUDIN_NERD_FONT = nerd ? '1' : '0'
  const out = await renderToString(
    <QuestionNavigationBar questions={questions} currentQuestionIndex={1} answers={{ 'Which fixes?': 'Yes' }} />,
    120,
  )
  return stripAnsi(out)
}

describe('QuestionNavigationBar — the answered mark on each tab', () => {
  test('on a Nerd Font an answered tab is a checked circle and an open one an empty circle', async () => {
    const out = await renderBar(true)
    expect(out).toContain(`${ANSWERED} Limpezas`)
    expect(out).toContain(`${UNANSWERED} spinnerVerbs`)
    expect(out).not.toContain('☒')
  })

  test('without a Nerd Font the tabs keep the figures checkboxes', async () => {
    const out = await renderBar(false)
    expect(out).toContain('☒ Limpezas')
    expect(out).toContain('☐ spinnerVerbs')
    expect(out).not.toMatch(PUA_RE)
  })
})
