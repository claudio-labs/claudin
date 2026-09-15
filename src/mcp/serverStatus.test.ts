import { describe, expect, test } from 'bun:test'
import {
  mcpBucket,
  mcpRowStatusText,
  mcpStatusText,
  type McpStatusInput,
} from 'src/mcp/serverStatus.js'

const ALL: McpStatusInput['type'][] = [
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
]

describe('mcpStatusText', () => {
  test('keeps the wording the /mcp panel already uses', () => {
    expect(mcpStatusText({ type: 'connected' })).toBe('connected')
    expect(mcpStatusText({ type: 'failed' })).toBe('failed')
    expect(mcpStatusText({ type: 'needs-auth' })).toBe('needs authentication')
    expect(mcpStatusText({ type: 'disabled' })).toBe('disabled')
  })

  test('a first connection attempt reads differently from a retry', () => {
    expect(mcpStatusText({ type: 'pending' })).toBe('connecting\u2026')
    expect(
      mcpStatusText({
        type: 'pending',
        reconnectAttempt: 2,
        maxReconnectAttempts: 5,
      }),
    ).toBe('reconnecting (2/5)\u2026')
  })

  test('a partial retry count falls back to connecting', () => {
    // Both halves come from the same reconnect bookkeeping; printing `(2/)`
    // would be worse than saying nothing about the attempt.
    expect(mcpStatusText({ type: 'pending', reconnectAttempt: 2 })).toBe(
      'connecting\u2026',
    )
    expect(mcpStatusText({ type: 'pending', maxReconnectAttempts: 5 })).toBe(
      'connecting\u2026',
    )
  })
})

describe('mcpRowStatusText', () => {
  test('calls a disabled row disconnected — the footer never shows the other kind', () => {
    expect(mcpRowStatusText({ type: 'disabled' })).toBe('disconnected')
  })

  test('agrees with the panel everywhere else', () => {
    for (const type of ALL) {
      if (type === 'disabled') continue
      expect(mcpRowStatusText({ type })).toBe(mcpStatusText({ type }))
    }
  })
})

describe('mcpBucket', () => {
  test('only a connected server counts as active', () => {
    expect(mcpBucket({ type: 'connected' })).toBe('active')
  })

  test('waiting on the user is inactive, not failed', () => {
    expect(mcpBucket({ type: 'needs-auth' })).toBe('inactive')
    expect(mcpBucket({ type: 'pending' })).toBe('inactive')
    expect(mcpBucket({ type: 'disabled' })).toBe('inactive')
  })

  test('failed is its own bucket', () => {
    expect(mcpBucket({ type: 'failed' })).toBe('failed')
  })

  test('every connection type lands in a bucket', () => {
    for (const type of ALL) {
      expect(['active', 'inactive', 'failed']).toContain(mcpBucket({ type }))
    }
  })
})
