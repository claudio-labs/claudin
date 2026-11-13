import { expect, test } from 'bun:test'

import type { AwaySummaryResult } from 'src/agent/awaySummary.js'
import { createUserMessage } from 'src/agent/messages/messages.js'
import { recapText } from 'src/commands/recap/recap.ts'

function text(result: AwaySummaryResult): Promise<string> {
  return recapText([], new AbortController().signal, async () => result)
}

test("each outcome reads as Claude Code's /recap does", async () => {
  expect(await text({ kind: 'ok', text: 'Shipping /recap. Next: the PR.', capped: false })).toBe(
    'Shipping /recap. Next: the PR.',
  )
  expect(await text({ kind: 'api-error', text: 'API Error: overloaded' })).toBe('API Error: overloaded')
  expect(await text({ kind: 'no-turn' })).toBe('Nothing to recap yet — send a message first.')
  expect(await text({ kind: 'aborted' })).toBe('Recap cancelled.')
  expect(await text({ kind: 'failed' })).toBe("Couldn't generate a recap. Run with --debug for details.")
})

test('hands the conversation and the abort signal to the generator', async () => {
  const messages = [createUserMessage({ content: 'hi' })]
  const controller = new AbortController()
  const seen: unknown[] = []
  await recapText(messages, controller.signal, async (m, s) => {
    seen.push(m, s)
    return { kind: 'no-turn' }
  })
  expect(seen).toEqual([messages, controller.signal])
})
