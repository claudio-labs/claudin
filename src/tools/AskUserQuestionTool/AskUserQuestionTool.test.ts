import { afterEach, describe, expect, test } from 'bun:test'

import { setQuestionPreviewFormat } from 'src/platform/bootstrap/state.js'
import { STATE } from 'src/platform/bootstrap/state/store.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AskUserQuestionTool } from 'src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import {
  ASK_USER_QUESTION_TOOL_PROMPT,
  DESCRIPTION,
  PREVIEW_FEATURE_PROMPT,
} from 'src/tools/AskUserQuestionTool/prompt.js'

function validQuestion(over: Record<string, unknown> = {}) {
  return {
    question: 'Pick one?',
    header: 'Pick',
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
    multiSelect: false,
    ...over,
  }
}

describe('AskUserQuestionTool', () => {
  test('flags: shouldDefer, read-only, concurrency-safe, requires user', () => {
    expect(AskUserQuestionTool.shouldDefer).toBe(true)
    expect(AskUserQuestionTool.isReadOnly?.({} as never)).toBe(true)
    expect(AskUserQuestionTool.isConcurrencySafe?.({} as never)).toBe(true)
    expect(AskUserQuestionTool.requiresUserInteraction?.()).toBe(true)
  })

  test('isEnabled() is true in the open build', () => {
    expect(AskUserQuestionTool.isEnabled?.()).toBe(true)
  })

  test('userFacingName is empty (rendered by UI helpers)', () => {
    expect(AskUserQuestionTool.userFacingName(undefined)).toBe('')
  })

  test('input schema requires 1-4 questions with 2-4 options', () => {
    const empty = AskUserQuestionTool.inputSchema.safeParse({ questions: [] })
    expect(empty.success).toBe(false)

    const tooFewOptions = AskUserQuestionTool.inputSchema.safeParse({
      questions: [
        {
          question: 'q?',
          header: 'q',
          options: [{ label: 'only', description: 'one' }],
        },
      ],
    })
    expect(tooFewOptions.success).toBe(false)

    const ok = AskUserQuestionTool.inputSchema.safeParse({
      questions: [validQuestion()],
    })
    expect(ok.success).toBe(true)
  })

  test('input schema rejects duplicate question texts', () => {
    const dup = AskUserQuestionTool.inputSchema.safeParse({
      questions: [validQuestion(), validQuestion()],
    })
    expect(dup.success).toBe(false)
  })

  test('input schema rejects duplicate option labels within a question', () => {
    const dup = AskUserQuestionTool.inputSchema.safeParse({
      questions: [
        validQuestion({
          options: [
            { label: 'Same', description: 'a' },
            { label: 'Same', description: 'b' },
          ],
        }),
      ],
    })
    expect(dup.success).toBe(false)
  })

  test('toAutoClassifierInput joins question texts with " | "', () => {
    expect(
      AskUserQuestionTool.toAutoClassifierInput?.({
        questions: [
          validQuestion({ question: 'First?' }),
          validQuestion({ question: 'Second?' }),
        ],
      } as never),
    ).toBe('First? | Second?')
  })

  test('validateInput() accepts when preview format is not html', async () => {
    const result = await AskUserQuestionTool.validateInput?.(
      { questions: [validQuestion()] } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('checkPermissions returns "ask"', async () => {
    const result = await AskUserQuestionTool.checkPermissions?.(
      { questions: [validQuestion()] } as never,
      {} as never,
    )
    expect(result?.behavior).toBe('ask')
    if (result?.behavior === 'ask') {
      expect(result.message).toBe('Answer questions?')
    }
  })

  test('call() echoes the questions, answers and annotations', async () => {
    const questions = [validQuestion()]
    const { data } = await AskUserQuestionTool.call(
      {
        questions,
        answers: { 'Pick one?': 'A' },
        annotations: { 'Pick one?': { notes: 'preferred' } },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    )
    expect(data.questions).toEqual(questions)
    expect(data.answers).toEqual({ 'Pick one?': 'A' })
    expect(data.annotations).toEqual({ 'Pick one?': { notes: 'preferred' } })
  })

  test('mapToolResultToToolResultBlockParam serialises answers + annotations', () => {
    const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam?.(
      {
        questions: [validQuestion()],
        answers: { 'Pick one?': 'A' },
        annotations: {
          'Pick one?': {
            preview: '<div>p</div>',
            notes: 'preferred',
          },
        },
      },
      'u1',
    )
    expect(block?.content).toContain('"Pick one?"="A"')
    expect(block?.content).toContain('selected preview')
    expect(block?.content).toContain('user notes: preferred')
  })

  test('notes on a question left unanswered still reach the model', () => {
    const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam?.(
      {
        questions: [validQuestion(), validQuestion({ question: 'Second?' })],
        answers: { 'Pick one?': 'A' },
        annotations: {
          'Second?': { notes: '"A": too slow' },
          'Third?': { preview: '<div>p</div>' },
        },
      },
      'u1',
    )
    expect(block?.content).toBe(
      'User has answered your questions: "Pick one?"="A", "Second?"=(no answer) user notes: "A": too slow. You can now continue with the user\'s answers in mind.',
    )
  })
})

describe('AskUserQuestionTool prompt and preview format', () => {
  afterEach(() => {
    STATE.questionPreviewFormat = undefined
  })

  test('description() is the static DESCRIPTION', async () => {
    expect(await AskUserQuestionTool.description({} as never, {} as never)).toBe(DESCRIPTION)
  })

  test('prompt() omits preview guidance until a preview format is set', async () => {
    expect(await AskUserQuestionTool.prompt({} as never)).toBe(ASK_USER_QUESTION_TOOL_PROMPT)
    setQuestionPreviewFormat('markdown')
    expect(await AskUserQuestionTool.prompt({} as never)).toBe(
      ASK_USER_QUESTION_TOOL_PROMPT + PREVIEW_FEATURE_PROMPT.markdown,
    )
  })

  // The dialog covers the transcript (ModalSlot), so a question that leans on
  // earlier output reads as a riddle; and a list of reasons to ask invited
  // asking what the first line forbids.
  test('the prompt asks for questions that stand on their own, without a list of reasons to ask', () => {
    expect(ASK_USER_QUESTION_TOOL_PROMPT).toContain('Make each one stand on its own')
    expect(ASK_USER_QUESTION_TOOL_PROMPT).not.toContain('This allows you to')
    expect(ASK_USER_QUESTION_TOOL_PROMPT).not.toContain('Offer choices to the user')
  })

  test('validateInput() checks every preview when the format is html', async () => {
    setQuestionPreviewFormat('html')
    const withPreview = (preview: string) =>
      AskUserQuestionTool.validateInput?.(
        {
          questions: [
            validQuestion({
              options: [
                { label: 'A', description: 'a', preview },
                { label: 'B', description: 'b' },
              ],
            }),
          ],
        } as never,
        {} as never,
      )

    expect((await withPreview('<div>ok</div>'))?.result).toBe(true)

    for (const [preview, fragment] of [
      ['<html><div>x</div></html>', 'not a full document'],
      ['<div><script>x</script></div>', 'must not contain <script>'],
      ['plain text', 'must contain HTML'],
    ] as const) {
      const result = await withPreview(preview)
      expect(result?.result).toBe(false)
      if (result?.result === false) {
        expect(result.message).toContain('Option "A" in question "Pick one?"')
        expect(result.message).toContain(fragment)
      }
    }
  })
})

describe('AskUserQuestionTool rendering', () => {
  test('tool use and progress render nothing', () => {
    expect(AskUserQuestionTool.renderToolUseMessage({} as never, {} as never)).toBeNull()
    expect(AskUserQuestionTool.renderToolUseProgressMessage?.([], {} as never)).toBeNull()
    expect(AskUserQuestionTool.renderToolUseErrorMessage?.({} as never, {} as never)).toBeNull()
  })

  test('the result lists every question with its answer', async () => {
    const out = await renderToString(
      AskUserQuestionTool.renderToolResultMessage?.(
        {
          questions: [validQuestion()],
          answers: { 'Pick one?': 'A', 'Second?': 'B, C' },
        },
        [],
        {} as never,
      ),
      80,
    )
    expect(out).toContain("User answered Claudin's questions:")
    expect(out).toContain('· Pick one? → A')
    expect(out).toContain('· Second? → B, C')
  })

  test('notes sit under their answer, and a notes-only question is listed too', async () => {
    const out = await renderToString(
      AskUserQuestionTool.renderToolResultMessage?.(
        {
          questions: [validQuestion()],
          answers: { 'Pick one?': 'A' },
          annotations: {
            'Pick one?': { notes: '"A": reuse it\n"B": too slow', preview: '<div>p</div>' },
            'Second?': { notes: '"C": maybe later' },
            'Third?': { preview: '<div>q</div>' },
          },
        },
        [],
        {} as never,
      ),
      80,
    )
    const flat = out.replace(/\s+/g, ' ')
    expect(flat).toContain('· Pick one? → A ⎿ "A": reuse it ⎿ "B": too slow')
    expect(flat).toContain('· Second? ⎿ "C": maybe later')
    expect(flat).not.toContain('Third?')
    expect(flat).not.toContain('<div>')
  })

  test('a rejected tool use says the user declined', async () => {
    const out = await renderToString(
      AskUserQuestionTool.renderToolUseRejectedMessage?.({} as never, {} as never),
      80,
    )
    expect(out).toContain('User declined to answer questions')
  })
})
