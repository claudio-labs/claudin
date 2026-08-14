import { describe, expect, test } from 'bun:test'

import { AskUserQuestionTool } from './AskUserQuestionTool.js'

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
})
