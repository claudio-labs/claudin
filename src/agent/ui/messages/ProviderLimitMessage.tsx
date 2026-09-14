import * as React from 'react'
import { useState } from 'react'
import { useInterval } from 'usehooks-ts'

import { MessageResponse } from 'src/agent/ui/MessageResponse.js'
import { RateLimitMessage } from 'src/agent/ui/messages/RateLimitMessage.js'
import {
  formatProviderLimitHead,
  formatProviderLimitMessage,
  PROVIDER_LIMIT_PREFIX,
  QUOTA_EXHAUSTED_PREFIX,
} from 'src/providers/rateLimitMessages.js'
import { useProviderRateLimit } from 'src/providers/rateLimitStateHook.js'
import { Text } from 'src/terminal/ink.js'

/**
 * The countdown reads in minutes, so a one-second tick would repaint the
 * transcript sixty times for every change the user can see.
 */
const COUNTDOWN_TICK_MS = 30_000

type Props = {
  text: string
  onOpenRateLimitOptions?: () => void
}

/**
 * Routes a rate-limit message to the renderer that owns it.
 *
 * `RateLimitMessage` carries the Anthropic subscription upsell (/upgrade,
 * /extra-usage) and the auto-opening options menu, so it stays responsible for
 * the messages the subscriber path produces. The provider-agnostic message —
 * the one every other provider now gets — is rendered here instead, with a
 * countdown that keeps running while the limit is in force.
 */
export function LimitMessage({ text, onOpenRateLimitOptions }: Props) {
  if (
    text.startsWith(PROVIDER_LIMIT_PREFIX) ||
    text.startsWith(QUOTA_EXHAUSTED_PREFIX)
  ) {
    return <ProviderLimitMessage text={text} />
  }
  return (
    <RateLimitMessage
      text={text}
      onOpenRateLimitOptions={onOpenRateLimitOptions}
    />
  )
}

/**
 * The limit message with a live remaining time.
 *
 * `text` is what was recorded in the transcript when the request failed, so it
 * is already stale by the time anyone reads it. When the limit it describes is
 * still the one in force, the line is rebuilt from the live record instead;
 * otherwise — a resumed session, a limit that has since been cleared, an older
 * message further up the scrollback — the recorded text is shown as it was.
 */
export function ProviderLimitMessage({ text }: { text: string }) {
  const limit = useProviderRateLimit()
  const [nowMs, setNowMs] = useState(() => Date.now())

  const isLive =
    limit !== null &&
    text.startsWith(formatProviderLimitHead(limit, limit.providerLabel))
  const shouldTick =
    isLive && limit.resetsAtMs !== undefined && limit.resetsAtMs > nowMs

  useInterval(() => setNowMs(Date.now()), shouldTick ? COUNTDOWN_TICK_MS : null)

  const line = isLive
    ? formatProviderLimitMessage(limit, limit.providerLabel, nowMs)
    : text

  return (
    <MessageResponse>
      <Text color="error">{line}</Text>
    </MessageResponse>
  )
}
