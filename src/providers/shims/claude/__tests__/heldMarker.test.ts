/**
 * What the `[Cache:]` line may blame on the clip frontier: a marker it held
 * short of the request's last message. Read from the rendered request, so a
 * marker something else placed — the opt-in deferral, or none at all with
 * prompt caching off — is never reported as an uncached tail the frontier
 * caused.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { heldMarker } from 'src/providers/shims/claude/renderMessages.js'

const message = (marked: boolean): BetaMessageParam => ({
  role: 'user',
  content: [{ type: 'text', text: 'x', ...(marked ? { cache_control: { type: 'ephemeral' as const } } : {}) }],
})

describe('heldMarker', () => {
  test('the frontier held the marker short of the last message', () => {
    const rendered = [message(false), message(true), message(false), message(false)]
    expect(heldMarker(rendered, { index: 1, reason: 'pending clip' })).toEqual({
      index: 1,
      total: 4,
      reason: 'pending clip',
    })
  })

  test('the lagging marker behind it does not count: the last marker is the one held', () => {
    const rendered = [message(true), message(false), message(true), message(false)]
    expect(heldMarker(rendered, { index: 2, reason: 'age prune' })).toEqual({
      index: 2,
      total: 4,
      reason: 'age prune',
    })
  })

  test('a marker the opt-in deferral placed before the frontier is not the frontier’s', () => {
    const rendered = [message(true), message(false), message(false), message(false)]
    expect(heldMarker(rendered, { index: 2, reason: 'pending clip' })).toBeNull()
  })

  test('no marker at all (prompt caching off) holds nothing', () => {
    const rendered = [message(false), message(false), message(false)]
    expect(heldMarker(rendered, { index: 1, reason: 'pending clip' })).toBeNull()
  })

  test('a frontier on the last message, or none, holds nothing', () => {
    const rendered = [message(false), message(false), message(true)]
    expect(heldMarker(rendered, { index: 2, reason: null })).toBeNull()
    expect(heldMarker(rendered, undefined)).toBeNull()
  })

  // streaming.ts builds the request inside queryModel, which no unit test
  // drives; the two facts it hands the detector are pinned on its source.
  test('streaming.ts reports the held marker and the input the response billed', () => {
    const source = readFileSync(`${import.meta.dir}/../streaming.ts`, 'utf8')
    expect(source).toContain('markerCap: heldMarker(renderedMessages, clipFrontier)')
    expect(source).toContain('usage.input_tokens,')
  })
})
