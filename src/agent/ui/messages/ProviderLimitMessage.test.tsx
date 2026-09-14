import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

import { APIError } from '@anthropic-ai/sdk'

import { AssistantTextMessage } from 'src/agent/ui/messages/AssistantTextMessage.js'
import { ProviderLimitMessage } from 'src/agent/ui/messages/ProviderLimitMessage.js'
import { extractRateLimitInfo } from 'src/providers/rateLimitInfo.js'
import {
  clearProviderRateLimit,
  publishProviderRateLimit,
} from 'src/providers/rateLimitState.js'
import { getAssistantMessageFromError } from 'src/providers/transport/errors.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

async function render(text: string, columns?: number): Promise<string> {
  const output = await renderToString(
    <AppStateProvider>
      <ProviderLimitMessage text={text} />
    </AppStateProvider>,
    columns,
  )
  return stripAnsi(output)
}

/**
 * Assert the fragments appear in this order and with nothing but whitespace
 * between them. A bare `toContain` passes on a render where a `<Box>` split the
 * line into independently wrapping columns, which is the failure mode that
 * looks like a typo rather than a layout bug.
 */
function expectInOrder(output: string, fragments: string[]): void {
  const flattened = output.replace(/\s+/g, ' ')
  expect(flattened).toContain(fragments.join(' '))
}

afterEach(() => {
  clearProviderRateLimit()
})

describe('ProviderLimitMessage', () => {
  test('recomputes the remaining time from the limit in force', async () => {
    // The transcript text was written when the request failed; an hour later
    // it would still claim "2h 14m" if the renderer just echoed it.
    publishProviderRateLimit({
      kind: 'window',
      source: 'openai-reset',
      resetsAtMs: Date.now() + 45 * 60_000,
      providerLabel: 'OpenAI',
      model: 'gpt-5',
      observedAtMs: Date.now() - 89 * 60_000,
    })

    const output = await render('Rate limit reached · OpenAI · resets in 2h 14m')

    expectInOrder(output, ['Rate limit reached', '·', 'OpenAI', '·', 'resets in 45m'])
    expect(output).not.toContain('2h 14m')
  })

  test('shows the recorded text when no limit is in force', async () => {
    const output = await render('Rate limit reached · OpenAI · resets in 2h 14m')

    expectInOrder(output, ['Rate limit reached', '·', 'OpenAI', '·', 'resets in 2h 14m'])
  })

  test('shows the recorded text when the live limit is a different one', async () => {
    // Two providers in one session, or a second limit after switching: an older
    // message must not start counting down someone else's clock.
    publishProviderRateLimit({
      kind: 'window',
      source: 'openai-reset',
      resetsAtMs: Date.now() + 45 * 60_000,
      providerLabel: 'Kimi',
      model: 'kimi-k2',
      observedAtMs: Date.now(),
    })

    const output = await render('Rate limit reached · OpenAI · resets in 2h 14m')

    expect(output).toContain('resets in 2h 14m')
    expect(output).not.toContain('45m')
  })

  test('renders as one line at a narrow width', async () => {
    publishProviderRateLimit({
      kind: 'window',
      source: 'openai-reset',
      resetsAtMs: Date.now() + 45 * 60_000,
      providerLabel: 'OpenAI',
      model: 'gpt-5',
      observedAtMs: Date.now(),
    })

    const output = await render('Rate limit reached · OpenAI · resets in 45m', 34)

    expectInOrder(output, ['Rate limit reached', '·', 'OpenAI', '·', 'resets in 45m'])
  })

  test('an exhausted quota renders without a countdown', async () => {
    publishProviderRateLimit({
      kind: 'exhausted',
      source: 'none',
      providerLabel: 'OpenAI',
      model: 'gpt-5',
      observedAtMs: Date.now(),
    })

    const output = await render(
      'Quota exhausted · OpenAI · enable billing for this provider, or switch with /provider',
    )

    expect(output).toContain('Quota exhausted')
    expect(output).toContain('/provider')
    expect(output).not.toContain('resets in')
  })
})

describe('a 429 reaches the countdown through the transcript', () => {
  test('the message errors.ts builds routes to the live renderer', async () => {
    // The seam this closes: the prefix has to be in RATE_LIMIT_ERROR_PREFIXES
    // for AssistantTextMessage to pick the rate-limit branch at all, and the
    // head has to match the published limit for the clock to be live. Either
    // half being wrong renders plain, stale text and nothing else fails.
    const error = APIError.generate(
      429,
      undefined,
      'OpenAI API error 429: rate limit exceeded [openai_category=rate_limited]',
      new Headers({ 'x-ratelimit-reset-requests': '2h14m0s' }),
    )
    const info = extractRateLimitInfo(error)
    expect(info).not.toBeNull()

    const built = getAssistantMessageFromError(error, 'gpt-5')
    const block = built.message.content[0]
    const text =
      block && typeof block === 'object' && 'text' in block
        ? String(block.text)
        : ''

    // Same limit, but 45 minutes have gone by since the message was recorded.
    const providerLabel = text.split(' · ')[1] ?? ''
    publishProviderRateLimit({
      ...info!,
      resetsAtMs: Date.now() + 89 * 60_000,
      providerLabel,
      model: 'gpt-5',
      observedAtMs: Date.now() - 45 * 60_000,
    })

    const output = stripAnsi(
      await renderToString(
        <AppStateProvider>
          <AssistantTextMessage
            param={{ type: 'text', text }}
            addMargin={false}
            shouldShowDot={false}
            verbose={false}
          />
        </AppStateProvider>,
      ),
    )

    expect(output).toContain('Rate limit reached')
    expect(output).toContain('resets in 1h 29m')
    expect(output).not.toContain('2h 14m')
  })
})
