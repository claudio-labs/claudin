import { afterEach, describe, expect, test } from 'bun:test'

import {
  generateAwaySummary,
  isAwaySummaryEnabled,
  MAX_RECAP_CHARS,
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

describe('generateAwaySummary', () => {
  type Query = NonNullable<Parameters<typeof generateAwaySummary>[2]>
  type Request = Parameters<Query>[0]

  // One model reply, so there is a turn to recap.
  const transcript = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) =>
      i === 1 ? createAssistantMessage({ content: `m${i}` }) : createUserMessage({ content: `m${i}` }),
    )

  function stub(reply: () => ReturnType<Query>): { query: Query; seen: Request[] } {
    const seen: Request[] = []
    const query: Query = req => {
      seen.push(req)
      return reply()
    }
    return { query, seen }
  }

  test('nothing to recap before the first reply, without asking the model', async () => {
    const { query, seen } = stub(async () => createAssistantMessage({ content: 'x' }))
    const signal = new AbortController().signal
    expect(await generateAwaySummary([], signal, query)).toEqual({ kind: 'no-turn' })
    expect(await generateAwaySummary([createUserMessage({ content: 'hi' })], signal, query)).toEqual({ kind: 'no-turn' })
    expect(
      await generateAwaySummary([createUserMessage({ content: 'hi' }), createAssistantAPIErrorMessage({ content: 'overloaded' })], signal, query),
    ).toEqual({ kind: 'no-turn' })
    expect(seen).toEqual([])
    const compacted = createUserMessage({ content: 'summary', isCompactSummary: true })
    expect((await generateAwaySummary([compacted], signal, query)).kind).toBe('ok')
  })

  test("sends the last 30 messages plus Claude Code's recap prompt, and returns the reply", async () => {
    const { query, seen } = stub(async () =>
      createAssistantMessage({ content: 'Building /recap. Next: wire the command.' }),
    )
    const recap = await generateAwaySummary(transcript(40), new AbortController().signal, query)
    expect(recap).toEqual({ kind: 'ok', text: 'Building /recap. Next: wire the command.', capped: false })
    const sent = seen[0]!
    expect(sent.messages).toHaveLength(31)
    expect(getUserMessageText(sent.messages[0]!)).toBe('m10')
    expect(getUserMessageText(sent.messages[30]!)).toBe(
      'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.',
    )
    expect(sent.options.querySource).toBe('away_summary')
    expect(sent.tools).toEqual([])
    expect(sent.thinkingConfig).toEqual({ type: 'disabled' })
  })

  test(`caps the recap at ${MAX_RECAP_CHARS} chars`, async () => {
    const { query } = stub(async () => createAssistantMessage({ content: 'w'.repeat(500) }))
    const recap = await generateAwaySummary(transcript(2), new AbortController().signal, query)
    expect(recap).toEqual({ kind: 'ok', text: `${'w'.repeat(MAX_RECAP_CHARS - 1)}…`, capped: true })
  })

  test('the cap never splits a character', async () => {
    const reply = `${'a'.repeat(MAX_RECAP_CHARS - 2)}😀 and more text past the cap`
    const { query } = stub(async () => createAssistantMessage({ content: reply }))
    const recap = await generateAwaySummary(transcript(2), new AbortController().signal, query)
    expect(recap).toEqual({ kind: 'ok', text: `${'a'.repeat(MAX_RECAP_CHARS - 2)}😀…`, capped: true })
    expect((recap as { text: string }).text.isWellFormed()).toBe(true)
  })

  test('strips leaked reasoning from the reply', async () => {
    const { query } = stub(async () =>
      createAssistantMessage({ content: '<thinking>hm</thinking>\nThe recap.' }),
    )
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toEqual({
      kind: 'ok',
      text: 'The recap.',
      capped: false,
    })
  })

  test('a reply of nothing but reasoning fails', async () => {
    const { query } = stub(async () => createAssistantMessage({ content: '<thinking>hm</thinking>' }))
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toEqual({ kind: 'failed' })
  })

  test('an API error message comes back with its text', async () => {
    const { query } = stub(async () => createAssistantAPIErrorMessage({ content: 'overloaded' }))
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toEqual({
      kind: 'api-error',
      text: 'overloaded',
    })
  })

  test('a thrown error fails', async () => {
    const { query } = stub(async () => {
      throw new Error('boom')
    })
    expect(await generateAwaySummary(transcript(2), new AbortController().signal, query)).toEqual({ kind: 'failed' })
  })

  test('an abort, thrown or after the reply, is reported as one', async () => {
    const controller = new AbortController()
    const { query } = stub(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    expect(await generateAwaySummary(transcript(2), controller.signal, query)).toEqual({ kind: 'aborted' })

    const late = new AbortController()
    const replied = stub(async () => {
      late.abort()
      return createAssistantMessage({ content: 'too late' })
    })
    expect(await generateAwaySummary(transcript(2), late.signal, replied.query)).toEqual({ kind: 'aborted' })
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
