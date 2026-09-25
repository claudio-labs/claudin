import { describe, expect, test } from 'bun:test'
import {
  isProgressUpdateBlock,
  modelDefaultsToOmittedThinking,
  progressUpdateHint,
  selectThinkingDisplay,
  type ThinkingDisplayFacts,
} from 'src/providers/shims/claude/thinkingDisplay.js'
import { thinkingSignature as signature } from 'src/providers/shims/claude/__testutils__/thinkingSignature.js'

const facts = (over: Partial<ThinkingDisplayFacts>): ThinkingDisplayFacts => ({
  realFirstParty: true,
  defaultsToOmitted: true,
  interactive: true,
  showThinkingSummaries: false,
  override: undefined,
  updatesAvailable: true,
  ...over,
})

describe('selectThinkingDisplay', () => {
  test('interactive on the real endpoint: "updates"', () => {
    expect(selectThinkingDisplay(facts({}))).toBe('updates')
  })

  test('headless: "omitted"', () => {
    expect(selectThinkingDisplay(facts({ interactive: false }))).toBe('omitted')
  })

  // The killswitch, or a 400 that latched the beta off: the session keeps an
  // explicit display rather than dropping back to no field at all.
  test('interactive without the updates beta: "omitted"', () => {
    expect(selectThinkingDisplay(facts({ updatesAvailable: false }))).toBe('omitted')
  })

  test('showThinkingSummaries asks for "summarized", on any model', () => {
    expect(selectThinkingDisplay(facts({ showThinkingSummaries: true }))).toBe('summarized')
    expect(
      selectThinkingDisplay(facts({ showThinkingSummaries: true, defaultsToOmitted: false })),
    ).toBe('summarized')
  })

  // An Opus 4.6 / Sonnet 4.6 session keeps the summaries it gets by default:
  // those models write no progress updates, so "updates" only takes away.
  test('a model whose default is "summarized" gets no field', () => {
    expect(selectThinkingDisplay(facts({ defaultsToOmitted: false }))).toBeUndefined()
    expect(
      selectThinkingDisplay(facts({ defaultsToOmitted: false, interactive: false })),
    ).toBeUndefined()
  })

  test('off the real endpoint, never a field — not even a forced one', () => {
    expect(selectThinkingDisplay(facts({ realFirstParty: false }))).toBeUndefined()
    expect(
      selectThinkingDisplay(facts({ realFirstParty: false, override: 'updates' })),
    ).toBeUndefined()
  })

  test('CLAUDIN_THINKING_DISPLAY forces a value, "updates" only with its beta', () => {
    expect(selectThinkingDisplay(facts({ interactive: false, override: 'updates' }))).toBe('updates')
    expect(selectThinkingDisplay(facts({ override: ' Summarized ' }))).toBe('summarized')
    expect(
      selectThinkingDisplay(facts({ override: 'updates', updatesAvailable: false })),
    ).toBe('omitted')
    // An unknown value is ignored rather than sent: the API would 400 on it.
    expect(selectThinkingDisplay(facts({ override: 'verbose' }))).toBe('updates')
  })
})

describe('isProgressUpdateBlock', () => {
  const update = 'Found the five call sites; renaming the definition next.'

  test('a block the signature marks "narration" is a progress update', () => {
    expect(isProgressUpdateBlock({ type: 'thinking', thinking: update, signature: signature('narration') })).toBe(true)
  })

  // Under display "summarized" reasoning comes back with text too; only the
  // signature tells it apart.
  test('a block marked "thinking" is reasoning, with or without text', () => {
    expect(isProgressUpdateBlock({ type: 'thinking', thinking: 'Let me reason.', signature: signature('thinking') })).toBe(false)
  })

  // Under "omitted" a progress update has an empty field: nothing to show.
  test('an empty narration block is not rendered as one', () => {
    expect(isProgressUpdateBlock({ type: 'thinking', thinking: '  ', signature: signature('narration') })).toBe(false)
  })

  test('anything it cannot read is not a progress update', () => {
    for (const sig of ['', 'not base64 at all', Buffer.from([0xff, 0xff, 0xff]).toString('base64'), 'SIG-REPLAY-PROBE-0001']) {
      expect(isProgressUpdateBlock({ type: 'thinking', thinking: update, signature: sig })).toBe(false)
    }
    expect(isProgressUpdateBlock({ type: 'redacted_thinking', thinking: update, signature: signature('narration') })).toBe(false)
  })
})

describe('progressUpdateHint', () => {
  // Claude Code 2.1.281 hides the hint where the model has quizzical_shore,
  // which its catalog grants through opus_5_5_prompt_bundle: Opus 5.5 alone.
  test('Opus 5.5 draws no hint', () => {
    expect(progressUpdateHint('claude-opus-5-5')).toBeUndefined()
  })

  test('every other model draws " · summarized"', () => {
    for (const model of ['claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1', undefined]) {
      expect(progressUpdateHint(model)).toBe('summarized')
    }
  })
})

describe('modelDefaultsToOmittedThinking', () => {
  test('the Claude 5 family, Mythos, and Opus 4.7 / 4.8', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-fable-5-1',
      'claude-sonnet-5',
      'claude-mythos-preview',
      'claude-opus-4-8',
      'claude-opus-4-7',
    ]) {
      expect(modelDefaultsToOmittedThinking(model)).toBe(true)
    }
  })

  test('not the models that default to "summarized"', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect(modelDefaultsToOmittedThinking(model)).toBe(false)
    }
  })
})
