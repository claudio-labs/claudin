/**
 * Characterization of the state hook behind the AskUserQuestion dialog, written
 * before the clean-base rewrite of permissions/askUserQuestion. The spec is
 * docs/tech/rewrite/permissions/askUserQuestion.md.
 *
 * The hook runs inside a component mounted on the fake terminal. Each step
 * calls one of its functions and then reads the state the next render hands
 * back, which is exactly what the dialog sees.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { type MultipleChoiceState, useMultipleChoiceState } from 'src/permissions/ui/AskUserQuestionPermissionRequest/use-multiple-choice-state.js'
import { isolatedWorld, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { Text } from 'src/terminal/ink.js'

isolatedWorld()

type Step = (hook: MultipleChoiceState) => void
type Seen = Pick<MultipleChoiceState, 'currentQuestionIndex' | 'answers' | 'questionStates' | 'isInTextInput'>

/** Mounts the hook, runs the steps one render apart, and returns the state after the last one. */
async function run(steps: Step[]): Promise<{ seen: Seen; renders: MultipleChoiceState[] }> {
  const renders: MultipleChoiceState[] = []
  function Host() {
    const hook = useMultipleChoiceState()
    renders.push(hook)
    return <Text>question {hook.currentQuestionIndex}</Text>
  }
  const screen = await mount(<Host />)
  for (const step of steps) {
    step(renders.at(-1)!)
    await Bun.sleep(30)
  }
  await screen.close()
  const last = renders.at(-1)!
  return {
    seen: { currentQuestionIndex: last.currentQuestionIndex, answers: last.answers, questionStates: last.questionStates, isInTextInput: last.isInTextInput },
    renders,
  }
}

const START: Seen = { currentQuestionIndex: 0, answers: {}, questionStates: {}, isInTextInput: false }

describe('useMultipleChoiceState', () => {
  type Case = { name: string; steps: Step[]; seen: Seen }
  const cases: Case[] = [
    { name: 'it starts on the first question with nothing answered', steps: [], seen: START },
    { name: 'next moves on with no upper bound', steps: [h => h.nextQuestion(), h => h.nextQuestion(), h => h.nextQuestion()], seen: { ...START, currentQuestionIndex: 3 } },
    { name: 'previous stops at the first question', steps: [h => h.nextQuestion(), h => h.prevQuestion(), h => h.prevQuestion()], seen: START },
    { name: 'text input mode is set and cleared', steps: [h => h.setTextInputMode(true)], seen: { ...START, isInTextInput: true } },
    { name: 'next leaves text input mode', steps: [h => h.setTextInputMode(true), h => h.nextQuestion()], seen: { ...START, currentQuestionIndex: 1 } },
    { name: 'previous leaves text input mode', steps: [h => h.nextQuestion(), h => h.setTextInputMode(true), h => h.prevQuestion()], seen: START },
    {
      name: 'an answer moves on by default and leaves text input mode',
      steps: [h => h.setTextInputMode(true), h => h.setAnswer('Q1?', 'A')],
      seen: { ...START, currentQuestionIndex: 1, answers: { 'Q1?': 'A' } },
    },
    {
      name: 'an answer that does not move on keeps the question and the text input mode',
      steps: [h => h.setTextInputMode(true), h => h.setAnswer('Q1?', 'A', false)],
      seen: { ...START, isInTextInput: true, answers: { 'Q1?': 'A' } },
    },
    {
      name: 'a later answer to the same question replaces the earlier one, and others are kept',
      steps: [h => h.setAnswer('Q1?', 'A'), h => h.setAnswer('Q2?', 'B'), h => h.setAnswer('Q1?', 'C', false)],
      seen: { ...START, currentQuestionIndex: 2, answers: { 'Q1?': 'C', 'Q2?': 'B' } },
    },
    {
      name: 'an empty answer is stored as given',
      steps: [h => h.setAnswer('Q1?', '', false)],
      seen: { ...START, answers: { 'Q1?': '' } },
    },
    {
      name: 'a first update of a single-choice question: no selection, empty text',
      steps: [h => h.updateQuestionState('Q1?', {}, false)],
      seen: { ...START, questionStates: { 'Q1?': { selectedValue: undefined, textInputValue: '' } } },
    },
    {
      name: 'a first update of a multi-choice question: an empty selection',
      steps: [h => h.updateQuestionState('Q1?', {}, true)],
      seen: { ...START, questionStates: { 'Q1?': { selectedValue: [], textInputValue: '' } } },
    },
    {
      name: 'updates merge: a new field replaces, a missing one keeps the old value',
      steps: [h => h.updateQuestionState('Q1?', { selectedValue: 'A' }, false), h => h.updateQuestionState('Q1?', { textInputValue: 'note' }, false)],
      seen: { ...START, questionStates: { 'Q1?': { selectedValue: 'A', textInputValue: 'note' } } },
    },
    {
      name: 'a later selection replaces the earlier one, and an empty text replaces a written one',
      steps: [
        h => h.updateQuestionState('Q1?', { selectedValue: ['A'], textInputValue: 'x' }, true),
        h => h.updateQuestionState('Q1?', { selectedValue: ['B', 'C'], textInputValue: '' }, true),
      ],
      seen: { ...START, questionStates: { 'Q1?': { selectedValue: ['B', 'C'], textInputValue: '' } } },
    },
    {
      name: 'each question keeps its own state, and updates do not move or answer',
      steps: [h => h.updateQuestionState('Q1?', { selectedValue: 'A' }, false), h => h.updateQuestionState('Q2?', { textInputValue: 'n' }, true)],
      seen: { ...START, questionStates: { 'Q1?': { selectedValue: 'A', textInputValue: '' }, 'Q2?': { selectedValue: [], textInputValue: 'n' } } },
    },
  ]
  for (const c of cases) {
    test(
      c.name,
      async () => {
        const { seen } = await run(c.steps)
        expect(seen).toEqual(c.seen)
      },
      SLOW,
    )
  }

  test(
    'its functions keep their identity across renders, so they can be handed down without re-rendering children',
    async () => {
      const { renders } = await run([h => h.nextQuestion(), h => h.setAnswer('Q?', 'A'), h => h.updateQuestionState('Q?', {}, false), h => h.setTextInputMode(true)])
      const first = renders[0]!
      const last = renders.at(-1)!
      expect(renders.length).toBeGreaterThan(1)
      for (const name of ['nextQuestion', 'prevQuestion', 'updateQuestionState', 'setAnswer', 'setTextInputMode'] as const) {
        expect(last[name]).toBe(first[name])
      }
    },
    SLOW,
  )
})
