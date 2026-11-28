/**
 * The local estimators: per-block sizing, message and attachment walks, and
 * the file-type ratio. Every expectation is written against the ratio the
 * estimator itself resolves (`getActiveModelBytesPerToken()`), so the suite
 * pins what each block type is sized BY, whichever model happens to be active.
 */
import { describe, expect, test } from 'bun:test'

import { normalizeAttachmentForAPI } from 'src/agent/messages/messages.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import {
  bytesPerTokenForFileType,
  getActiveModelBytesPerToken,
  getBytesPerTokenForModel,
  roughTokenCountEstimationForContent,
  roughTokenCountEstimationForFileType,
  roughTokenCountEstimationForMessage,
  roughTokenCountEstimationForMessages,
} from 'src/shared/tokenEstimation.js'

type Content = Parameters<typeof roughTokenCountEstimationForContent>[0]

/** What the estimator charges for `text` at the active ratio. */
function est(text: string): number {
  return Math.round(text.length / getActiveModelBytesPerToken())
}

function blocks(...items: unknown[]): Content {
  return items as Content
}

describe('bytesPerTokenForFileType', () => {
  test('the JSON family is dense (2 bytes/token); everything else is 4', () => {
    expect(bytesPerTokenForFileType('json')).toBe(2)
    expect(bytesPerTokenForFileType('jsonl')).toBe(2)
    expect(bytesPerTokenForFileType('jsonc')).toBe(2)
    expect(bytesPerTokenForFileType('ts')).toBe(4)
    expect(bytesPerTokenForFileType('')).toBe(4)
  })

  test('a non-JSON extension ignores the model ratio and uses 4', () => {
    expect(roughTokenCountEstimationForFileType('x'.repeat(400), 'md')).toBe(100)
  })
})

describe('getBytesPerTokenForModel', () => {
  test('families the other suites leave out', () => {
    expect(getBytesPerTokenForModel('gpt-5.5')).toBe(4)
    expect(getBytesPerTokenForModel('gpt-3.5-turbo')).toBe(4)
    expect(getBytesPerTokenForModel('llama-3.3-70b')).toBe(3.8)
    expect(getBytesPerTokenForModel('cohere-embed')).toBe(4)
  })
})

describe('roughTokenCountEstimationForContent', () => {
  test('undefined and empty string are 0; a string is sized directly', () => {
    expect(roughTokenCountEstimationForContent(undefined)).toBe(0)
    expect(roughTokenCountEstimationForContent('')).toBe(0)
    const text = 'a'.repeat(700)
    expect(roughTokenCountEstimationForContent(text)).toBe(est(text))
  })

  test('an empty block list is 0', () => {
    expect(roughTokenCountEstimationForContent([])).toBe(0)
  })

  test('text blocks are sized by their text', () => {
    const text = 'b'.repeat(350)
    expect(roughTokenCountEstimationForContent(blocks({ type: 'text', text }))).toBe(est(text))
  })

  test('a bare string inside the list is sized like text', () => {
    const text = 'c'.repeat(140)
    expect(roughTokenCountEstimationForContent(blocks(text))).toBe(est(text))
  })

  test('an image whose size cannot be read costs the 2000-token fallback', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }
    expect(roughTokenCountEstimationForContent(blocks(image))).toBe(2000)
  })

  test('a document is a flat 2000 however large its base64 payload is', () => {
    const doc = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'A'.repeat(1_000_000) },
    }
    expect(roughTokenCountEstimationForContent(blocks(doc))).toBe(2000)
  })

  test('a tool_result recurses into its content, string or blocks', () => {
    const inner = 'd'.repeat(210)
    expect(
      roughTokenCountEstimationForContent(
        blocks({ type: 'tool_result', tool_use_id: 't1', content: inner }),
      ),
    ).toBe(est(inner))
    expect(
      roughTokenCountEstimationForContent(
        blocks({
          type: 'tool_result',
          tool_use_id: 't2',
          content: [
            { type: 'text', text: inner },
            { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } },
          ],
        }),
      ),
    ).toBe(est(inner) + 2000)
    expect(
      roughTokenCountEstimationForContent(blocks({ type: 'tool_result', tool_use_id: 't3' })),
    ).toBe(0)
  })

  test('a tool_use is sized by its name plus its serialized input', () => {
    const input = { command: 'ls -la '.repeat(40), timeout: 1000 }
    expect(
      roughTokenCountEstimationForContent(
        blocks({ type: 'tool_use', id: 'u1', name: 'Bash', input }),
      ),
    ).toBe(est(`Bash${JSON.stringify(input)}`))
  })

  test('a tool_use with no input counts as an empty object', () => {
    expect(
      roughTokenCountEstimationForContent(blocks({ type: 'tool_use', id: 'u2', name: 'Glob' })),
    ).toBe(est('Glob{}'))
  })

  test('thinking is sized by its text, redacted thinking by its data — not the signature', () => {
    const thinking = 'e'.repeat(420)
    expect(
      roughTokenCountEstimationForContent(
        blocks({ type: 'thinking', thinking, signature: 'S'.repeat(5000) }),
      ),
    ).toBe(est(thinking))
    const data = 'f'.repeat(280)
    expect(
      roughTokenCountEstimationForContent(blocks({ type: 'redacted_thinking', data })),
    ).toBe(est(data))
  })

  test('any other block type is sized by its serialized form', () => {
    const serverToolUse = {
      type: 'server_tool_use',
      id: 'srv_1',
      name: 'web_search',
      input: { query: 'bun test coverage' },
    }
    expect(roughTokenCountEstimationForContent(blocks(serverToolUse))).toBe(
      est(JSON.stringify(serverToolUse)),
    )
  })

  test('a mixed list is the sum of its blocks', () => {
    const text = 'g'.repeat(350)
    const thinking = 'h'.repeat(70)
    expect(
      roughTokenCountEstimationForContent(
        blocks(
          { type: 'text', text },
          { type: 'thinking', thinking, signature: 's' },
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } },
        ),
      ),
    ).toBe(est(text) + est(thinking) + 2000)
  })
})

describe('roughTokenCountEstimationForMessage(s)', () => {
  test('user and assistant messages are sized by their content', () => {
    const userText = 'i'.repeat(350)
    const assistantText = 'j'.repeat(700)
    expect(
      roughTokenCountEstimationForMessage({ type: 'user', message: { content: userText } }),
    ).toBe(est(userText))
    expect(
      roughTokenCountEstimationForMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text: assistantText }] },
      }),
    ).toBe(est(assistantText))
  })

  test('a message with no content, and any other message type, is 0', () => {
    expect(roughTokenCountEstimationForMessage({ type: 'user', message: {} })).toBe(0)
    expect(roughTokenCountEstimationForMessage({ type: 'user' })).toBe(0)
    expect(
      roughTokenCountEstimationForMessage({ type: 'system', message: { content: 'k'.repeat(99) } }),
    ).toBe(0)
    expect(roughTokenCountEstimationForMessage({ type: 'attachment' })).toBe(0)
  })

  test('an attachment is sized by what it renders into for the API', () => {
    const reminder = 'Never push to main. '.repeat(30)
    const attachment = {
      type: 'critical_system_reminder',
      content: reminder,
    } as unknown as Attachment
    const rendered = normalizeAttachmentForAPI(attachment)
    expect(rendered.length).toBeGreaterThan(0)
    const expected = rendered.reduce(
      (sum, m) => sum + roughTokenCountEstimationForContent(m.message.content as Content),
      0,
    )

    const result = roughTokenCountEstimationForMessage({ type: 'attachment', attachment })

    expect(result).toBe(expected)
    // The rendered form wraps the reminder, so it costs more than the raw text.
    expect(result).toBeGreaterThan(est(reminder))
  })

  test('an attachment that renders to nothing is 0', () => {
    const attachment = { type: 'output_style', style: 'no-such-style' } as unknown as Attachment
    expect(normalizeAttachmentForAPI(attachment)).toEqual([])
    expect(roughTokenCountEstimationForMessage({ type: 'attachment', attachment })).toBe(0)
  })

  test('the list form sums every message, and an empty list is 0', () => {
    const a = 'l'.repeat(350)
    const b = 'm'.repeat(140)
    expect(roughTokenCountEstimationForMessages([])).toBe(0)
    expect(
      roughTokenCountEstimationForMessages([
        { type: 'user', message: { content: a } },
        { type: 'progress' },
        { type: 'assistant', message: { content: [{ type: 'text', text: b }] } },
      ]),
    ).toBe(est(a) + est(b))
  })
})
