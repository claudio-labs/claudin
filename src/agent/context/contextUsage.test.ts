import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'

import { calculateContextPercentages } from 'src/agent/context/context.js'
import {
  getCurrentUsage,
  tokenCountWithEstimation,
} from 'src/agent/context/tokens.js'
import {
  createAssistantMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'

// One measure of how full the window is. Autocompact and the relief lane
// read tokenCountWithEstimation: the last response's input, cache and output
// (the next request reads that output back), plus an estimate of whatever
// arrived since. The footer warning, the status line, /context and the
// plan-exit dialog show the same count, so at rest they agree with each other
// and with the trigger.

function historyEndingIn(usage: {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}) {
  const assistant = createAssistantMessage({ content: 'done' })
  Object.assign(assistant.message as Record<string, unknown>, {
    id: 'msg_usage',
    model: 'claude-sonnet-4',
    usage,
  })
  return [createUserMessage({ content: 'go' }), assistant]
}

test('at rest, the status line percentage is the count autocompact reads', () => {
  const history = historyEndingIn({
    input_tokens: 1_000,
    cache_creation_input_tokens: 4_000,
    cache_read_input_tokens: 90_000,
    output_tokens: 5_000,
  })
  expect(tokenCountWithEstimation(history)).toBe(100_000)
  expect(calculateContextPercentages(getCurrentUsage(history), 200_000)).toEqual({
    used: 50,
    remaining: 50,
  })
})

// The three callers below are a React-Compiler component, the status-line
// hook input and /context's 430-line analysis, none of which a unit test can
// drive without the model: the wiring is pinned on the source.
const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('the footer warning counts what autocompact counts', () => {
  const notifications = source('../../terminal/prompt-input/Notifications.tsx')
  expect(notifications).toContain(
    'tokenCountWithEstimation(messagesForTokenCount)',
  )
  expect(notifications).not.toContain('tokenCountFromLastAPIResponse')
})

test('/context reserves the space up to the autocompact trigger, override included', () => {
  expect(source('./analyzeContext.ts')).toMatch(
    /isAutoCompact\s*\?\s*getAutoCompactThreshold\(model\)/,
  )
})

test('/context totals the last response the way the status line does', () => {
  expect(source('./analyzeContext.ts')).toContain(
    'getTokenCountFromUsage(apiUsage)',
  )
})
