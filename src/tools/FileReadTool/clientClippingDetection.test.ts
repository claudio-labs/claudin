import { describe, expect, test } from 'bun:test'

import {
  buildClipStub,
  buildClipStubWithHead,
} from 'src/services/compact/stableStubState.js'
import { userWithToolResult } from './__test-helpers__/contextManagementFixtures.js'
import { isPriorReadClippedOrMissing } from './clientClippingDetection.js'

const ID = 'toolu_read_1'

describe('isPriorReadClippedOrMissing', () => {
  test('intact string content → false (dedup stays armed)', () => {
    const messages = [userWithToolResult(ID, '     1\talpha\n     2\tbeta')]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(false)
  })

  test('pure clip stub → true', () => {
    const messages = [userWithToolResult(ID, buildClipStub('Read', 1234))]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(true)
  })

  test('head-preserving clip stub → true', () => {
    const messages = [
      userWithToolResult(
        ID,
        buildClipStubWithHead('Read', 1234, 'const x = 1\nconst y = 2'),
      ),
    ]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(true)
  })

  test('tool_result absent from the transcript → true (fail toward correctness)', () => {
    expect(isPriorReadClippedOrMissing([], ID)).toBe(true)
    const messages = [userWithToolResult('toolu_other', buildClipStub('Read', 9))]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(true)
  })

  test('block-array content → false (still real content)', () => {
    const messages = [
      userWithToolResult(ID, [{ type: 'text', text: 'real file body' }]),
    ]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(false)
  })

  test('bare API message shape ({role, content}) is scanned too', () => {
    const clipped = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: ID, content: buildClipStub('Read', 7) },
        ],
      },
    ]
    expect(isPriorReadClippedOrMissing(clipped, ID)).toBe(true)
    const intact = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: ID, content: 'body' }],
      },
    ]
    expect(isPriorReadClippedOrMissing(intact, ID)).toBe(false)
  })

  test('huge content merely ending in a head marker is NOT a stub → false', () => {
    // Mirrors HEAD_STUB_MAX_PLAUSIBLE_CHARS: a model cat-ing a transcript that
    // happens to end with a marker line must not disarm dedup for it.
    const giant = buildClipStubWithHead('Read', 9999, 'x'.repeat(33_000))
    const messages = [userWithToolResult(ID, giant)]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(false)
  })

  test('non-user and malformed messages are skipped without throwing', () => {
    const messages = [
      null,
      42,
      { type: 'assistant', message: { role: 'assistant', content: 'hi' } },
      { type: 'user', message: { role: 'user', content: 'plain string' } },
      userWithToolResult(ID, 'intact body'),
    ]
    expect(isPriorReadClippedOrMissing(messages, ID)).toBe(false)
  })
})
