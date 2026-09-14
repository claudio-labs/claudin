import { describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { createSystemAPIErrorMessage } from 'src/agent/messages/messages.js'
import { SystemAPIErrorMessage } from 'src/agent/ui/messages/SystemAPIErrorMessage.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

async function render(error: APIError, attempt: number): Promise<string> {
  const message = createSystemAPIErrorMessage(error, 3_000, attempt, 10)
  return stripAnsi(
    await renderToString(
      <AppStateProvider>
        <SystemAPIErrorMessage message={message} verbose={false} />
      </AppStateProvider>,
    ),
  )
}

const rateLimit = () =>
  APIError.generate(429, undefined, 'rate limited', new Headers({ 'retry-after': '3' }))
const serverError = () =>
  APIError.generate(500, undefined, 'internal error', new Headers())

describe('SystemAPIErrorMessage', () => {
  test('shows a rate-limit retry from the first attempt', async () => {
    // A short throttle is now the only 429 that reaches the retry loop at all —
    // anything longer ends the turn — so hiding it until the fourth attempt
    // meant the wait was never explained.
    const output = await render(rateLimit(), 1)

    expect(output).toContain('Retrying in')
    expect(output).toContain('(attempt 1/10)')
  })

  test('still hides an ordinary error until the fourth attempt', async () => {
    expect(await render(serverError(), 1)).not.toContain('Retrying in')
    expect(await render(serverError(), 3)).not.toContain('Retrying in')
  })

  test('shows an ordinary error once the retries add up', async () => {
    expect(await render(serverError(), 4)).toContain('Retrying in')
  })
})
