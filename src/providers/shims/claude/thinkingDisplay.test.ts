import { describe, expect, test } from 'bun:test'
import {
  isProgressUpdateBlock,
  modelDefaultsToOmittedThinking,
  selectThinkingDisplay,
  type ThinkingDisplayFacts,
} from 'src/providers/shims/claude/thinkingDisplay.js'

// A synthetic signature with the layout a real Fable 5.1 response had: field
// 1 = 4, field 2 = { 1: { 1: 18, 3: 2, 7: 1, 8: <kind> }, 2..5: opaque }, and
// field 3 = 1. Real signatures are not committed: they are account-bound
// blobs, and the parser only needs the layout.
const varint = (n: number): number[] => {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}
const key = (field: number, wire: number) => varint(field * 8 + wire)
const bytesField = (field: number, body: number[]) => [...key(field, 2), ...varint(body.length), ...body]
const varintField = (field: number, n: number) => [...key(field, 0), ...varint(n)]
const text = (s: string) => [...new TextEncoder().encode(s)]
const opaque = (n: number) => Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)

function signature(kind: string): string {
  const header = [...varintField(1, 18), ...varintField(3, 2), ...varintField(7, 1), ...bytesField(8, text(kind))]
  const inner = [
    ...bytesField(1, header),
    ...bytesField(2, opaque(12)),
    ...bytesField(3, opaque(12)),
    ...bytesField(4, opaque(48)),
    ...bytesField(5, opaque(300)),
  ]
  return Buffer.from([...varintField(1, 4), ...bytesField(2, inner), ...varintField(3, 1)]).toString('base64')
}

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
