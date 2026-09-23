import { describe, expect, test } from 'bun:test'
import type { Message } from 'src/shared/types/message.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import {
  buildTruncationNotice,
  truncateTranscriptForHookEvaluator,
} from 'src/platform/lifecycleHooks/transcriptTruncation.js'

// Known Anthropic model id → 200k context window. Budget = 50% = 100k tokens.
const MODEL = 'claude-3-5-haiku-20241022'

function userMessage(content: string): Message {
  return createUserMessage({ content })
}

function toolResultMessage(toolUseId: string): Message {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'tool output',
      },
    ],
  })
}

function textOf(message: Message): string {
  if (message.type !== 'user') return ''
  const content = message.message.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('truncateTranscriptForHookEvaluator', () => {
  test('returns the transcript unchanged when within budget', () => {
    const messages = [userMessage('hello'), userMessage('world')]
    const result = truncateTranscriptForHookEvaluator(messages, MODEL)
    expect(result.omittedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })

  test('drops oldest messages and prepends a notice when over budget', () => {
    // ~50KB per message ≈ 12.5k tokens at 4 bytes/token; 20 messages ≈ 250k
    // tokens — well over the 100k budget.
    const big = 'x'.repeat(50_000)
    const messages = Array.from({ length: 20 }, (_, i) =>
      userMessage(`message-${i} ${big}`),
    )

    const result = truncateTranscriptForHookEvaluator(messages, MODEL)
    expect(result.omittedCount).toBeGreaterThan(0)
    expect(result.omittedCount).toBeLessThan(messages.length)

    // Notice is prepended as a synthetic user message with the omitted count
    const notice = textOf(result.messages[0]!)
    expect(notice).toBe(buildTruncationNotice(result.omittedCount))
    expect(notice).toContain(
      `${result.omittedCount} earlier messages omitted`,
    )
    expect(notice).toContain('"insufficient evidence in transcript"')

    // Kept slice is the most recent suffix, in order
    expect(result.messages).toHaveLength(
      messages.length - result.omittedCount + 1,
    )
    expect(textOf(result.messages[1]!)).toContain(
      `message-${result.omittedCount}`,
    )
    expect(textOf(result.messages.at(-1)!)).toContain('message-19')
  })

  test('always keeps the most recent message even if alone over budget', () => {
    const huge = 'y'.repeat(1_000_000) // ~250k tokens on its own
    const messages = [userMessage('old'), userMessage(`latest ${huge}`)]
    const result = truncateTranscriptForHookEvaluator(messages, MODEL)
    expect(result.omittedCount).toBe(1)
    expect(textOf(result.messages.at(-1)!)).toContain('latest')
  })

  test('does not start the kept slice on an orphaned tool_result', () => {
    const big = 'z'.repeat(120_000) // ~30k tokens each
    const messages: Message[] = [
      userMessage(`m0 ${big}`),
      userMessage(`m1 ${big}`),
      userMessage(`m2 ${big}`),
      userMessage(`m3 ${big}`),
      toolResultMessage('tool-1'),
      userMessage('tail-a'),
      userMessage('tail-b'),
    ]
    const result = truncateTranscriptForHookEvaluator(messages, MODEL)
    expect(result.omittedCount).toBeGreaterThan(0)
    // First kept conversation message must not be a bare tool_result
    const firstKept = result.messages[1]!
    expect(textOf(firstKept)).not.toContain('tool_result')
  })

  test('empty transcript is returned unchanged', () => {
    const result = truncateTranscriptForHookEvaluator([], MODEL)
    expect(result.omittedCount).toBe(0)
    expect(result.messages).toEqual([])
  })

  // A file attachment keeps the Read block it rendered at creation
  // (`rendered`, types.ts): the same file again. 250k chars is 62-78k tokens
  // at the estimator's 3.2-4 bytes/token, inside the 100k budget; counted
  // twice it is 125-156k, over it, and the oldest message would be dropped.
  test('a file attachment counts once, not again for the block it rendered', () => {
    const body = 'f'.repeat(250_000)
    const attachment = {
      type: 'attachment',
      uuid: '00000000-0000-4000-8000-00000000f11e',
      timestamp: '2026-09-23T10:00:00.000Z',
      attachment: {
        type: 'file',
        filename: '/repo/big.txt',
        displayPath: 'big.txt',
        content: {
          type: 'text',
          file: { filePath: '/repo/big.txt', content: body, numLines: 1, startLine: 1, totalLines: 1 },
        },
        rendered: `     1\t${body}`,
      },
    } as unknown as Message
    const messages = [userMessage('what does big.txt say?'), attachment]

    const result = truncateTranscriptForHookEvaluator(messages, MODEL)

    expect(result.omittedCount).toBe(0)
    expect(result.messages).toBe(messages)
  })
})
