/**
 * Characterization of natural-language dates in MCP elicitation forms:
 * `dateTimeParser.ts`, and the async check in `elicitationValidation.ts` that
 * falls back to it. Pinned before the clean-base rewrite.
 *
 * The model is the boundary. `queryHaiku` is replaced by a stand-in that
 * records each request and answers with the reply the test chose. The clock
 * and the time zone are fixed per test (`setSystemTime`, `TZ`), because the
 * request tells the model what "now" is.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import type { PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'

type ModelRequest = {
  systemPrompt: readonly string[]
  userPrompt: string
  signal: AbortSignal
  options: Record<string, unknown>
}

const asked: ModelRequest[] = []
let answer: { text: string } | { fails: string } = { text: 'INVALID' }

const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: async (request: ModelRequest) => {
    asked.push(request)
    if ('fails' in answer) throw new Error(answer.fails)
    return { message: { content: [{ type: 'text', text: answer.text }] } }
  },
}))

const { parseNaturalLanguageDateTime, looksLikeISO8601 } = await import('src/mcp/dateTimeParser.js')
const { validateElicitationInputAsync } = await import('src/mcp/elicitationValidation.js')

const savedTz = process.env.TZ

beforeEach(() => {
  asked.length = 0
  answer = { text: 'INVALID' }
  process.env.TZ = 'UTC'
  setSystemTime(new Date('2026-03-04T05:06:07.890Z'))
})

afterEach(() => {
  setSystemTime()
})

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

const live = () => new AbortController().signal
const onlyRequest = () => {
  expect(asked).toHaveLength(1)
  return asked[0]!
}

// --- deciding whether to ask the model at all --------------------------------

describe('looksLikeISO8601', () => {
  const cases: Array<[string, boolean]> = [
    ['2024-03-15', true],
    ['2024-03-15T', true],
    ['2024-03-15T09:00', true],
    ['2024-13-45', true],
    ['  2024-03-15  ', true],
    ['2024-03-15 09:00', false],
    ['2024-03-15x', false],
    ['2024-3-15', false],
    ['20240315', false],
    ['15/03/2024', false],
    ['tomorrow', false],
    ['', false],
  ]
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(looksLikeISO8601(input)).toBe(expected)
    })
  }
})

// --- the request sent to the model --------------------------------------------

describe('what the model is told', () => {
  test('the instructions ask for bare ISO 8601, future-leaning, and the INVALID sentinel', async () => {
    await parseNaturalLanguageDateTime('next friday', 'date', live())
    const system = onlyRequest().systemPrompt.join('\n')
    expect(system).toContain('ISO 8601')
    expect(system).toMatch(/ONLY/)
    expect(system).toMatch(/future/)
    expect(system).toContain('"INVALID"')
  })

  test('the request names the input, the instant in UTC, and the source of the call', async () => {
    const signal = live()
    await parseNaturalLanguageDateTime('the day after "tomorrow"', 'date', signal)
    const request = onlyRequest()
    expect(request.userPrompt).toContain('User input: "the day after "tomorrow""')
    expect(request.userPrompt).toContain('2026-03-04T05:06:07.890Z (UTC)')
    expect(request.userPrompt).toContain('"INVALID"')
    expect(request.signal).toBe(signal)
    expect(request.options).toMatchObject({ querySource: 'mcp_datetime_parse', mcpTools: [], agents: [] })
  })

  test('a date asks for YYYY-MM-DD with no time part', async () => {
    await parseNaturalLanguageDateTime('friday', 'date', live())
    const prompt = onlyRequest().userPrompt
    expect(prompt).toContain('Output format: YYYY-MM-DD (date only, no time)')
    expect(prompt).not.toContain('THH:MM:SS')
  })

  const zones: Array<{ tz: string; now: string; offset: string; weekday: string }> = [
    { tz: 'UTC', now: '2026-03-04T05:06:07.890Z', offset: '+00:00', weekday: 'Wednesday' },
    { tz: 'America/Sao_Paulo', now: '2026-03-04T05:06:07.890Z', offset: '-03:00', weekday: 'Wednesday' },
    // 01:00 UTC on Wednesday is still Tuesday evening in Sao Paulo: the weekday is local.
    { tz: 'America/Sao_Paulo', now: '2026-03-04T01:00:00.000Z', offset: '-03:00', weekday: 'Tuesday' },
    { tz: 'Asia/Kolkata', now: '2026-03-04T20:00:00.000Z', offset: '+05:30', weekday: 'Thursday' },
    { tz: 'Pacific/Marquesas', now: '2026-03-04T05:06:07.890Z', offset: '-09:30', weekday: 'Tuesday' },
  ]
  for (const { tz, now, offset, weekday } of zones) {
    test(`in ${tz} at ${now}: offset ${offset}, ${weekday}`, async () => {
      process.env.TZ = tz
      setSystemTime(new Date(now))
      await parseNaturalLanguageDateTime('in two hours', 'date-time', live())
      const prompt = onlyRequest().userPrompt
      expect(prompt).toContain(`${now} (UTC)`)
      expect(prompt).toContain(`Local timezone: ${offset}`)
      expect(prompt).toContain(`Day of week: ${weekday}`)
      expect(prompt).toContain(`Output format: YYYY-MM-DDTHH:MM:SS${offset} (full date-time with timezone)`)
    })
  }
})

// --- reading the model's reply --------------------------------------------------

describe('parseNaturalLanguageDateTime', () => {
  const UNPARSED = 'Unable to parse date/time from input'
  const replies: Array<{ reply: string; result: { success: true; value: string } | { success: false; error: string } }> = [
    { reply: '2026-03-05', result: { success: true, value: '2026-03-05' } },
    { reply: '  2026-03-05\n', result: { success: true, value: '2026-03-05' } },
    { reply: '2026-03-05T15:00:00-03:00', result: { success: true, value: '2026-03-05T15:00:00-03:00' } },
    { reply: '', result: { success: false, error: UNPARSED } },
    { reply: '   ', result: { success: false, error: UNPARSED } },
    { reply: 'INVALID', result: { success: false, error: UNPARSED } },
    { reply: '\nINVALID ', result: { success: false, error: UNPARSED } },
    { reply: 'Sure! 2026-03-05', result: { success: false, error: UNPARSED } },
    { reply: '26-03-05', result: { success: false, error: UNPARSED } },
  ]
  for (const { reply, result } of replies) {
    test(`the reply ${JSON.stringify(reply)}`, async () => {
      answer = { text: reply }
      expect(await parseNaturalLanguageDateTime('whenever', 'date', live())).toEqual(result)
    })
  }

  test('a failed model call is reported with a hint to type ISO 8601, never with its cause', async () => {
    answer = { fails: 'socket hang up at api.example' }
    const result = await parseNaturalLanguageDateTime('whenever', 'date-time', live())
    expect(result).toEqual({
      success: false,
      error: 'Unable to parse date/time. Please enter in ISO 8601 format manually.',
    })
  })
})

// --- the async check that falls back to the model ------------------------------

describe('validateElicitationInputAsync', () => {
  const DATE = { type: 'string', format: 'date' } as PrimitiveSchemaDefinition
  const DATE_TIME = { type: 'string', format: 'date-time' } as PrimitiveSchemaDefinition

  test('a value that already passes is returned without asking the model', async () => {
    const cases: Array<[string, PrimitiveSchemaDefinition, string | number]> = [
      ['2024-02-03', DATE, '2024-02-03'],
      ['2024-02-03T04:05:06Z', DATE_TIME, '2024-02-03T04:05:06Z'],
      ['12', { type: 'integer' } as PrimitiveSchemaDefinition, 12],
    ]
    for (const [input, schema, value] of cases) {
      expect(await validateElicitationInputAsync(input, schema, live())).toEqual({ isValid: true, value })
    }
    expect(asked).toHaveLength(0)
  })

  test('natural language in a date field is resolved by the model, with the field format and signal', async () => {
    answer = { text: '2026-03-05' }
    const signal = live()
    expect(await validateElicitationInputAsync('tomorrow', DATE, signal)).toEqual({ isValid: true, value: '2026-03-05' })
    const request = onlyRequest()
    expect(request.userPrompt).toContain('User input: "tomorrow"')
    expect(request.userPrompt).toContain('YYYY-MM-DD (date only, no time)')
    expect(request.signal).toBe(signal)
  })

  test('natural language in a date-time field asks for a full date-time', async () => {
    answer = { text: '2026-03-05T15:00:00+00:00' }
    expect(await validateElicitationInputAsync('tomorrow at 3pm', DATE_TIME, live())).toEqual({
      isValid: true,
      value: '2026-03-05T15:00:00+00:00',
    })
    expect(onlyRequest().userPrompt).toContain('(full date-time with timezone)')
  })

  test('the model is not asked for input shaped like ISO 8601, nor for other fields', async () => {
    const cases: Array<[string, PrimitiveSchemaDefinition, string]> = [
      ['2023-02-29', DATE, 'Must be a valid date, e.g. 2024-03-15, today, next Monday'],
      ['2024-03-15T25:00', DATE_TIME, 'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm'],
      ['next week', { type: 'string', format: 'email' } as PrimitiveSchemaDefinition, 'Must be a valid email address, e.g. user@example.com'],
      ['soon', { type: 'number' } as PrimitiveSchemaDefinition, 'Must be a number'],
    ]
    for (const [input, schema, error] of cases) {
      expect(await validateElicitationInputAsync(input, schema, live())).toEqual({ isValid: false, error })
    }
    expect(asked).toHaveLength(0)
  })

  test('when the model cannot help, the field keeps its own error', async () => {
    const DATE_ERROR = { isValid: false, error: 'Must be a valid date, e.g. 2024-03-15, today, next Monday' }
    const DATE_TIME_ERROR = {
      isValid: false,
      error: 'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm',
    }
    const cases: Array<{ reply: typeof answer; schema: PrimitiveSchemaDefinition; expected: object }> = [
      { reply: { text: 'INVALID' }, schema: DATE, expected: DATE_ERROR },
      { reply: { fails: 'offline' }, schema: DATE, expected: DATE_ERROR },
      // A reply the model gets wrong is checked like typed input, and refused.
      { reply: { text: '2026-03-05' }, schema: DATE_TIME, expected: DATE_TIME_ERROR },
      { reply: { text: '2026-03-05T15:00:00' }, schema: DATE_TIME, expected: DATE_TIME_ERROR },
      { reply: { text: '2026-02-30' }, schema: DATE, expected: DATE_ERROR },
    ]
    for (const { reply, schema, expected } of cases) {
      answer = reply
      expect((await validateElicitationInputAsync('someday', schema, live())) as unknown).toEqual(expected)
    }
    expect(asked).toHaveLength(cases.length)
  })

  test('the field limits still apply to the resolved value, and the error is the one for the typed text', async () => {
    answer = { text: '2026-03-05' }
    const schema = { type: 'string', format: 'date', maxLength: 6 } as PrimitiveSchemaDefinition
    expect(await validateElicitationInputAsync('friday', schema, live())).toEqual({
      isValid: false,
      error: 'Must be a valid date, e.g. 2024-03-15, today, next Monday',
    })
    expect(asked).toHaveLength(1)
  })
})
