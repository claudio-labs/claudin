import { afterEach, describe, expect, test } from 'bun:test'

import {
  generateAwaySummary,
  isAwaySummaryEnabled,
  sanitizeAwaySummary,
} from 'src/agent/awaySummary.ts'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  getUserMessageText,
} from 'src/agent/messages/messages.ts'
import type { Message } from 'src/shared/types/message.js'

describe('isAwaySummaryEnabled', () => {
  const ENV = 'CLAUDIN_AWAY_SUMMARY'
  const saved = process.env[ENV]
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  test('on by default, CLAUDIN_AWAY_SUMMARY=0 turns it off', () => {
    delete process.env[ENV]
    expect(isAwaySummaryEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(isAwaySummaryEnabled()).toBe(false)
  })
})

test('generateAwaySummary has nothing to recap in an empty transcript', async () => {
  expect(await generateAwaySummary([], new AbortController().signal)).toBeNull()
})

describe('generateAwaySummary', () => {
  type Query = NonNullable<Parameters<typeof generateAwaySummary>[2]>
  type Request = Parameters<Query>[0]

  const transcript = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => createUserMessage({ content: `m${i}` }))

  function stub(reply: () => ReturnType<Query>): { query: Query; seen: Request[] } {
    const seen: Request[] = []
    const query: Query = req => {
      seen.push(req)
      return reply()
    }
    return { query, seen }
  }

  test('sends the last 30 messages plus the recap prompt, and returns the reply', async () => {
    const { query, seen } = stub(async () =>
      createAssistantMessage({ content: 'Building /recap. Next: wire the command.' }),
    )
    const recap = await generateAwaySummary(transcript(40), new AbortController().signal, query)
    expect(recap).toBe('Building /recap. Next: wire the command.')
    const sent = seen[0]!
    expect(sent.messages).toHaveLength(31)
    expect(getUserMessageText(sent.messages[0]!)).toBe('m10')
    expect(getUserMessageText(sent.messages[30]!)).toStartWith('The user stepped away and is coming back.')
    expect(sent.options.querySource).toBe('away_summary')
    expect(sent.tools).toEqual([])
    expect(sent.thinkingConfig).toEqual({ type: 'disabled' })
  })

  test('strips leaked reasoning from the reply', async () => {
    const { query } = stub(async () =>
      createAssistantMessage({ content: '<thinking>hm</thinking>\nThe recap.' }),
    )
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toBe('The recap.')
  })

  test('an API error message yields no recap', async () => {
    const { query } = stub(async () => createAssistantAPIErrorMessage({ content: 'overloaded' }))
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toBeNull()
  })

  test('a thrown error yields no recap', async () => {
    const { query } = stub(async () => {
      throw new Error('boom')
    })
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toBeNull()
  })

  test('an abort yields no recap', async () => {
    const controller = new AbortController()
    const { query } = stub(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    expect(await generateAwaySummary(transcript(2), controller.signal, query)).toBeNull()
  })
})

describe('sanitizeAwaySummary', () => {
  test('passes a clean recap through untouched', () => {
    const recap = "You're evaluating fork vs named agents. Next step: decide."
    expect(sanitizeAwaySummary(recap)).toBe(recap)
  })

  test('drops a leading <thinking> block and keeps the recap', () => {
    const leaked = `<thinking>
The user is asking me to write a brief summary of what we've been discussing.
Let me write 1-3 short sentences.
</thinking>

You're evaluating fork vs named agents. Next step: decide.`
    expect(sanitizeAwaySummary(leaked)).toBe(
      "You're evaluating fork vs named agents. Next step: decide.",
    )
  })

  test('returns null when the response is nothing but reasoning', () => {
    expect(sanitizeAwaySummary('<thinking>only reasoning</thinking>')).toBeNull()
  })

  test('returns null when an unterminated block eats the whole body', () => {
    expect(sanitizeAwaySummary('<think>\nreasoning that never closed')).toBeNull()
  })

  test('passes null through', () => {
    expect(sanitizeAwaySummary(null)).toBeNull()
  })
})
