/**
 * The two places where the elicitation form hands off to something it cannot
 * be driven through in a test, each replaced by a recorder:
 *
 * - the small model that turns "next friday" into an ISO date
 *   (`queryHaiku`). The dialog asks it, through the field check of
 *   mcp/elicitation, when a date field holds text that failed the plain check;
 * - the idle notification hook, which stays silent under the test runner.
 *
 * Written before the clean-base rewrite of mcp/elicitationDialog; the spec is
 * docs/tech/rewrite/mcp/elicitationDialog.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

// --- the model --------------------------------------------------------------------

type Asked = { userPrompt: string; signal: AbortSignal; release: (reply: string) => void }
const asked: Asked[] = []
/** When set, every request is answered at once with it; otherwise the test releases each. */
let instantReply: string | undefined

const realShim = { ...(await import('src/providers/shims/claude.js')) }
mock.module('src/providers/shims/claude.js', () => ({
  ...realShim,
  queryHaiku: (request: { userPrompt: string; signal: AbortSignal }) =>
    new Promise(resolve => {
      const release = (text: string) => resolve({ message: { content: [{ type: 'text', text }] } })
      asked.push({ userPrompt: request.userPrompt, signal: request.signal, release })
      if (instantReply !== undefined) release(instantReply)
    }),
}))

// --- the notification ------------------------------------------------------------------

const notices: Array<[message: string, kind: string]> = []
const realNotifier = { ...(await import('src/platform/notifications/useNotifyAfterTimeout.js')) }
mock.module('src/platform/notifications/useNotifyAfterTimeout.js', () => ({
  ...realNotifier,
  useNotifyAfterTimeout: (message: string, kind: string) => {
    notices.push([message, kind])
  },
}))

afterAll(() => {
  mock.module('src/providers/shims/claude.js', () => realShim)
  mock.module('src/platform/notifications/useNotifyAfterTimeout.js', () => realNotifier)
})

const { Text } = await import('src/terminal/ink.js')
const { isolatedWorld, KEYS, SLOW } = await import('src/permissions/ui/__testutils__/promptFrameRig.js')
const { fieldRow, letters, openForm, openLink, rows } = await import('src/mcp/ui/__testutils__/elicitationRig.js')

isolatedWorld()
const { enter, up, down } = KEYS

const savedTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'UTC'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})
beforeEach(() => {
  asked.length = 0
  notices.length = 0
  instantReply = undefined
})

const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] when: /
const DATE_HINT = 'Must be a valid date, e.g. 2024-03-15, today, next Monday'
const dateForm = () => openForm({ fields: { when: { type: 'string', format: 'date' }, next: { type: 'string' } } })

async function settle(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waited in vain for ${what}`)
    await Bun.sleep(20)
  }
  await Bun.sleep(80)
}

describe('natural-language dates', () => {
  test(
    'text that fails the date check is flagged while typed; leaving the field asks the model, with a spinner until it answers',
    async () => {
      const opened = await dateForm()
      await opened.screen.press(...letters('next friday'))
      expect(rows(opened.screen.text())).toContain(DATE_HINT)
      expect(asked).toHaveLength(0)
      await opened.screen.press(down)
      expect(asked).toHaveLength(1)
      expect(asked[0]!.userPrompt).toContain('"next friday"')
      expect(asked[0]!.userPrompt).toContain('YYYY-MM-DD (date only')
      expect(fieldRow(opened.screen.text(), 'when')).toMatch(SPINNER)
      asked[0]!.release('2026-03-06')
      await settle(() => !SPINNER.test(fieldRow(opened.screen.text(), 'when')), 'the spinner to go')
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'when')).toBe('✔ when: Fri, Mar 6, 2026')
      expect(rows(frame)).not.toContain(DATE_HINT)
      await opened.screen.press(up)
      expect(fieldRow(opened.screen.text(), 'when')).toBe('❯ ✔ when: 2026-03-06')
      await opened.screen.press(down, down, enter)
      expect(opened.log).toEqual([{ via: 'onResponse', action: 'accept', content: { when: '2026-03-06' } }])
    },
    SLOW,
  )

  test(
    'a model reply that is no date leaves the typed text and its message, and Accept stays blocked',
    async () => {
      instantReply = 'INVALID'
      const opened = await dateForm()
      await opened.screen.press(...letters('someday'), down)
      await settle(() => asked.length === 1, 'the model to be asked')
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'when')).toBe('⚠ when: someday')
      expect(rows(frame)).toContain(DATE_HINT)
      await opened.screen.press(down, enter)
      expect(opened.log).toEqual([])
    },
    SLOW,
  )

  test(
    'a date that passes the plain check is never sent to the model',
    async () => {
      const opened = await dateForm()
      await opened.screen.press(...letters('2026-01-02'), down)
      await Bun.sleep(200)
      expect(asked).toHaveLength(0)
    },
    SLOW,
  )

  test(
    'after two idle seconds in the field the model is asked, and its answer replaces the text being edited',
    async () => {
      instantReply = '2026-03-09'
      const opened = await dateForm()
      await opened.screen.press(...letters('monday'))
      await Bun.sleep(1_200)
      expect(asked).toHaveLength(0)
      await settle(() => asked.length === 1, 'the idle request')
      expect(asked[0]!.userPrompt).toContain('"monday"')
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'when')).toBe('❯ ✔ when: 2026-03-09')
      expect(rows(frame)).not.toContain(DATE_HINT)
    },
    SLOW,
  )

  test(
    'each keystroke restarts the idle wait, and leaving the field asks at once instead, only once',
    async () => {
      instantReply = '2026-03-09'
      const opened = await dateForm()
      await opened.screen.press(...letters('mon'))
      await Bun.sleep(1_200)
      await opened.screen.press(...letters('day'))
      await Bun.sleep(1_200)
      expect(asked).toHaveLength(0)
      await opened.screen.press(down)
      await Bun.sleep(2_300)
      expect(asked.map(request => request.userPrompt.includes('"monday"'))).toEqual([true])
    },
    SLOW,
  )

  test(
    'asking again for the same field abandons the earlier request',
    async () => {
      const opened = await dateForm()
      await opened.screen.press(...letters('soon'), down, up, '!', down)
      expect(asked).toHaveLength(2)
      expect(asked[0]!.signal.aborted).toBe(true)
      expect(asked[1]!.signal.aborted).toBe(false)
      asked[0]!.release('2020-01-01')
      asked[1]!.release('2026-04-01')
      await settle(() => fieldRow(opened.screen.text(), 'when').startsWith('✔'), 'the second answer')
      expect(fieldRow(opened.screen.text(), 'when')).toBe('✔ when: Wed, Apr 1, 2026')
    },
    SLOW,
  )

  test(
    'closing the dialog abandons a request still in flight',
    async () => {
      const opened = await dateForm()
      await opened.screen.press(...letters('later'), down)
      expect(asked).toHaveLength(1)
      await opened.screen.replace(<Text>closed</Text>)
      expect(asked[0]!.signal.aborted).toBe(true)
      expect(opened.log).toEqual([])
    },
    SLOW,
  )
})

test(
  'closing the dialog during the idle wait means the model is never asked',
  async () => {
    const opened = await dateForm()
    await opened.screen.press(...letters('later'))
    await opened.screen.replace(<Text>closed</Text>)
    await Bun.sleep(2_300)
    expect(asked).toHaveLength(0)
  },
  SLOW,
)

describe('the idle notification', () => {
  test(
    'a form asks for "Claudin needs your input" as elicitation_dialog',
    async () => {
      await openForm({ fields: {} })
      expect(new Set(notices.map(notice => notice.join(' | ')))).toEqual(new Set(['Claudin needs your input | elicitation_dialog']))
    },
    SLOW,
  )

  test(
    'a URL request asks for the same message as elicitation_url_dialog',
    async () => {
      await openLink({ url: 'https://example.com/' })
      expect(new Set(notices.map(notice => notice.join(' | ')))).toEqual(new Set(['Claudin needs your input | elicitation_url_dialog']))
    },
    SLOW,
  )
})
