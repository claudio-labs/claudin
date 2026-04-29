import { describe, expect, test } from 'bun:test'

import { stripReinjectedAttachments } from './compact.js'

// `stripReinjectedAttachments` removes attachment types that
// runPostCompactCleanup is responsible for re-emitting on the next turn, so
// the summarizer doesn't see stale duplicates. The bash_git_instructions
// path is the load-bearing change in this PR — it has no fallback path, so
// a regression here would silently double-charge the model after every
// compact. These tests pin the contract.
describe('stripReinjectedAttachments', () => {
  function attachmentMessage(type: string, extras: Record<string, unknown> = {}) {
    return {
      type: 'attachment',
      attachment: { type, ...extras },
    } as unknown as Parameters<typeof stripReinjectedAttachments>[0][number]
  }

  function userMessage(text: string) {
    return {
      type: 'user',
      message: { role: 'user', content: text },
    } as unknown as Parameters<typeof stripReinjectedAttachments>[0][number]
  }

  test('removes bash_git_instructions attachments', () => {
    const messages = [
      userMessage('first'),
      attachmentMessage('bash_git_instructions', { content: 'git protocol body' }),
      userMessage('second'),
    ]
    const result = stripReinjectedAttachments(messages)
    expect(result).toHaveLength(2)
    expect(result.every(m => m.type !== 'attachment')).toBe(true)
  })

  test('preserves non-reinjected attachment types', () => {
    const messages = [
      attachmentMessage('file', { path: '/tmp/foo' }),
      attachmentMessage('bash_git_instructions', { content: 'x' }),
      attachmentMessage('directory', { path: '/tmp/bar' }),
    ]
    const result = stripReinjectedAttachments(messages)
    expect(result).toHaveLength(2)
    const types = result
      .filter(m => m.type === 'attachment')
      .map(m => (m as { attachment: { type: string } }).attachment.type)
    expect(types).toContain('file')
    expect(types).toContain('directory')
    expect(types).not.toContain('bash_git_instructions')
  })

  test('removing multiple bash_git_instructions in the same transcript', () => {
    // Subagent + main thread can both end up with a copy mid-session.
    const messages = [
      attachmentMessage('bash_git_instructions', { content: 'a' }),
      userMessage('between'),
      attachmentMessage('bash_git_instructions', { content: 'b' }),
    ]
    const result = stripReinjectedAttachments(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('user')
  })

  test('empty input returns empty output', () => {
    expect(stripReinjectedAttachments([])).toEqual([])
  })
})
