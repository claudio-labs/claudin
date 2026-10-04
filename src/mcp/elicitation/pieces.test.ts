/**
 * The pure pieces behind the elicitation handler, validation and date parser,
 * where the characterization suites do not reach them: the answer pipeline's
 * edges, the date request built from a given clock, and the typed-input rules
 * past the pinned cases.
 */
import { describe, expect, test } from 'bun:test'
import type { ElicitRequestParams, ElicitResult, PrimitiveSchemaDefinition } from '@modelcontextprotocol/sdk/types.js'

import { answerElicitation, type AnswerPipelineDeps, waitForAnswer } from 'src/mcp/elicitation/answerPipeline.js'
import { buildDateRequest, formatOffset, readClock } from 'src/mcp/elicitation/dateRequest.js'
import { checkField } from 'src/mcp/elicitation/fieldChecks.js'
import { hookAnswer } from 'src/mcp/elicitation/hookRunners.js'
import { createElicitationEvent, markElicitationCompleted } from 'src/mcp/elicitation/queue.js'
import type { ElicitationRequestEvent } from 'src/mcp/elicitationHandler.js'

const FORM = { message: 'm', requestedSchema: { type: 'object', properties: {} } } as ElicitRequestParams
const URL_ASK = { mode: 'url', message: 'm', url: 'https://a.test', elicitationId: 'el-1' } as ElicitRequestParams
const live = () => new AbortController().signal

describe('waitForAnswer', () => {
  test('a signal already aborted settles as cancel without presenting anything', async () => {
    const stop = new AbortController()
    stop.abort()
    let presented = false
    expect(await waitForAnswer(stop.signal, () => (presented = true))).toEqual({ action: 'cancel' })
    expect(presented).toBe(false)
  })

  test('the first answer wins, and an abort after it changes nothing', async () => {
    const stop = new AbortController()
    const answer = waitForAnswer(stop.signal, respond => {
      respond({ action: 'accept', content: { a: 1 } })
      respond({ action: 'decline' })
    })
    stop.abort()
    expect(await answer).toEqual({ action: 'accept', content: { a: 1 } })
  })

  test('a presenter that throws rejects, and a later abort is not heard', async () => {
    const stop = new AbortController()
    const failing = waitForAnswer(stop.signal, () => {
      throw new Error('no store')
    })
    await expect(failing).rejects.toThrow('no store')
    expect(() => stop.abort()).not.toThrow()
  })
})

describe('answerElicitation', () => {
  const request = { serverName: 's', requestId: 7, params: URL_ASK, signal: live() }

  function deps(overrides: Partial<AnswerPipelineDeps> = {}) {
    const calls: string[] = []
    const errors: unknown[] = []
    const base: AnswerPipelineDeps = {
      runRequestHooks: async () => {
        calls.push('request hooks')
        return undefined
      },
      askUser: async () => {
        calls.push('user')
        return { action: 'accept', content: { x: 'y' } }
      },
      runResultHooks: async (_server, result, _signal, mode, id) => {
        calls.push(`result hooks ${mode} ${id}`)
        return result
      },
      onError: (_server, error) => errors.push(error),
    }
    return { deps: { ...base, ...overrides }, calls, errors }
  }

  test('request hooks, then the user, then the result hooks with the mode and id', async () => {
    const { deps: d, calls } = deps()
    expect(await answerElicitation(request, d)).toEqual({ action: 'accept', content: { x: 'y' } })
    expect(calls).toEqual(['request hooks', 'user', 'result hooks url el-1'])
  })

  test('an answer from the request hooks is final', async () => {
    const { deps: d, calls } = deps({ runRequestHooks: async () => ({ action: 'decline' }) })
    expect(await answerElicitation(request, d)).toEqual({ action: 'decline' })
    expect(calls).toEqual([])
  })

  test('a failure anywhere answers cancel and is reported', async () => {
    const failure = new Error('boom')
    const { deps: d, errors } = deps({
      askUser: async () => {
        throw failure
      },
    })
    expect(await answerElicitation(request, d)).toEqual({ action: 'cancel' })
    expect(errors).toEqual([failure])
  })
})

describe('a hook answer', () => {
  const cases: Array<[ElicitResult, ElicitResult]> = [
    [{ action: 'decline', content: { leaked: 'x' } }, { action: 'decline' }],
    [{ action: 'accept', content: { a: 'b' } }, { action: 'accept', content: { a: 'b' } }],
    [{ action: 'cancel' }, { action: 'cancel' }],
  ]
  for (const [given, kept] of cases) {
    test(`${JSON.stringify(given)} is kept as ${JSON.stringify(kept)}`, () => {
      const answer = hookAnswer(given)
      expect(answer).toEqual(kept)
      expect('content' in answer && answer.content !== undefined).toBe(kept.content !== undefined)
    })
  }
})

describe('the queue', () => {
  const respond = (_: ElicitResult) => {}
  test('only a URL event gets a waiting state', () => {
    const form = createElicitationEvent({ serverName: 's', requestId: 1, params: FORM, signal: live(), respond })
    const url = createElicitationEvent({ serverName: 's', requestId: 2, params: URL_ASK, signal: live(), respond })
    expect('waitingState' in form).toBe(false)
    expect(url.waitingState).toEqual({ actionLabel: 'Skip confirmation' })
  })

  test('marking leaves the events it does not match untouched, and the queue array new', () => {
    const queue = [
      createElicitationEvent({ serverName: 'other', requestId: 1, params: URL_ASK, signal: live(), respond }),
      createElicitationEvent({ serverName: 's', requestId: 2, params: URL_ASK, signal: live(), respond }),
    ] satisfies ElicitationRequestEvent[]
    const marked = markElicitationCompleted(queue, 's', 'el-1')
    expect(marked).not.toBe(queue)
    expect(marked[0]).toBe(queue[0]!)
    expect(marked[1]).toEqual({ ...queue[1]!, completed: true })
    expect(queue[1]!.completed).toBeUndefined()
  })
})

describe('the date request', () => {
  const offsets: Array<[number, string]> = [
    [0, '+00:00'],
    [-180, '-03:00'],
    [330, '+05:30'],
    [-570, '-09:30'],
    [840, '+14:00'],
  ]
  for (const [minutes, text] of offsets) {
    test(`${minutes} minutes east reads ${text}`, () => {
      expect(formatOffset(minutes)).toBe(text)
    })
  }

  test('is built from the clock it is given', () => {
    const clock = { utc: '2030-01-02T03:04:05.000Z', offset: '+09:00', weekday: 'Wednesday' }
    const { instructions, prompt } = buildDateRequest('noon', 'date-time', clock)
    expect(instructions.join('\n')).toContain('"INVALID"')
    // The prompt names the clock, the zone, the weekday, the input and the format, in that order.
    const facts = [
      '2030-01-02T03:04:05.000Z (UTC)',
      'Local timezone: +09:00',
      'Day of week: Wednesday',
      'User input: "noon"',
      'Output format: YYYY-MM-DDTHH:MM:SS+09:00 (full date-time with timezone)',
    ]
    const at = facts.map(fact => prompt.indexOf(fact))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test('reads the instant from the date it is given', () => {
    expect(readClock(new Date('2030-01-02T03:04:05.000Z')).utc).toBe('2030-01-02T03:04:05.000Z')
  })
})

describe('typed input past the pinned cases', () => {
  const EMAIL = 'Must be a valid email address, e.g. user@example.com'
  const URI = 'Must be a valid URI, e.g. https://example.com'
  const DATE_TIME = 'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm'
  const cases: Array<[object, string, string | number | undefined, string?]> = [
    [{ type: 'string', format: 'email' }, 'a.b+tag@mail.example.co', 'a.b+tag@mail.example.co'],
    [{ type: 'string', format: 'email' }, 'a b@example.org', undefined, EMAIL],
    [{ type: 'string', format: 'email' }, 'a@@example.org', undefined, EMAIL],
    [{ type: 'string', format: 'email' }, 'a@-example.org', undefined, EMAIL],
    [{ type: 'string', format: 'uri' }, 'urn:isbn:0451450523', 'urn:isbn:0451450523'],
    [{ type: 'string', format: 'uri' }, '/relative/path', undefined, URI],
    [{ type: 'string', format: 'uri' }, '', undefined, URI],
    [{ type: 'string', format: 'date-time' }, '2024-03-15T23:59:59+14:00', '2024-03-15T23:59:59+14:00'],
    [{ type: 'string', format: 'date-time' }, '2024-03-15T24:00:00Z', undefined, DATE_TIME],
    [{ type: 'string', format: 'date-time' }, '2024-02-30T10:00:00Z', undefined, DATE_TIME],
    [{ type: 'string', format: 'date-time' }, '2024-03-15T10:00Z', undefined, DATE_TIME],
    [{ type: 'string', format: 'date-time' }, '2024-03-15T10:00:00+0300', undefined, DATE_TIME],
    [{ type: 'string', format: 'constructor' }, 'any', 'any'],
    [{ type: 'integer', minimum: -2, maximum: 2 }, '-2', -2],
    [{ type: 'number', minimum: 0.25 }, '0.25', 0.25],
    [{ type: 'number', maximum: 3 }, '3.5', undefined, 'Must be a number <= 3.0'],
  ]
  for (const [schema, input, value, error] of cases) {
    test(`${JSON.stringify(input)} against ${JSON.stringify(schema)}`, () => {
      expect(checkField(input, schema as PrimitiveSchemaDefinition)).toEqual(
        error === undefined ? { isValid: true, value } : { isValid: false, error },
      )
    })
  }

  test('a choice outside an empty list is refused with a message of its own', () => {
    expect(checkField('x', { type: 'string', enum: [] } as PrimitiveSchemaDefinition)).toEqual({
      isValid: false,
      error: 'There is no value to choose from',
    })
  })

  test('a choice outside the list names every allowed value', () => {
    expect(checkField('x', { type: 'string', enum: ['a', 'b"c'] } as PrimitiveSchemaDefinition)).toEqual({
      isValid: false,
      error: 'Must be one of "a", "b\\"c"',
    })
  })
})
