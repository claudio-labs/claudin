import { describe, expect, test } from 'bun:test'
import React from 'react'

import type { HeldPeerMessage } from 'src/sessions/peers/heldMessages.js'
import { sanitizePeerText } from 'src/sessions/peers/sanitize.js'
import { HeldPeerMessageDialog } from 'src/sessions/peers/ui/HeldPeerMessageDialog.js'
import { renderToString } from 'src/terminal/render/staticRender.js'

function held(body: string): HeldPeerMessage {
  return {
    id: 'm1',
    sender: { name: 'claudin-goal', address: 'uds:/s/1.sock' },
    reason: 'the sender runs with permissions bypassed and this session does not',
    body,
    command: { value: body, mode: 'task-notification' },
    expiresAt: Date.now() + 60_000,
  } as HeldPeerMessage
}

describe('sanitizePeerText', () => {
  test('keeps text, tabs and newlines; drops escapes, bidi overrides and bare controls', () => {
    expect(sanitizePeerText('a\tb\nc')).toBe('a\tb\nc')
    expect(sanitizePeerText('run\u001b[8m hidden\u001b[28m')).toBe('run hidden')
    expect(sanitizePeerText('abc\u202edef')).toBe('abcdef')
    expect(sanitizePeerText('line\roverwritten\u0007\u009b')).toBe('lineoverwritten')
  })

  test('leaves ordinary Unicode alone', () => {
    expect(sanitizePeerText('ação — 日本語 ✓')).toBe('ação — 日本語 ✓')
  })
})

describe('HeldPeerMessageDialog', () => {
  test('a short message is shown whole, with no option to expand', async () => {
    const out = await renderToString(
      <HeldPeerMessageDialog message={held('run the tests\nand report')} onDecision={() => {}} />,
      100,
    )
    expect(out).toContain('run the tests')
    expect(out).toContain('and report')
    expect(out).not.toContain('Show all')
  })

  test('a long one opens on its first lines and offers the rest before a decision', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = await renderToString(
      <HeldPeerMessageDialog message={held(body)} onDecision={() => {}} />,
      100,
    )
    expect(out).toContain('line 12')
    expect(out).not.toContain('line 13')
    expect(out).toContain('18 more lines — show them before you deliver it')
    expect(out).toContain('Show all 30 lines')
  })
})
