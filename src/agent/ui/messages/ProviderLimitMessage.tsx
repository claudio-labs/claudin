import * as React from 'react'
import { useState } from 'react'
import { useInterval } from 'usehooks-ts'

import { MessageResponse } from 'src/agent/ui/MessageResponse.js'
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

/**
 * Routes a rate-limit message to the renderer that owns it.
 *
 * A provider limit gets the live countdown below. Anything else — the Anthropic
 * subscription limit among them — is shown as recorded.
 *
 * There used to be a third path here: `RateLimitMessage`, which appended an
 * upsell line (`/upgrade or /extra-usage to finish what you're working on`) and
 * auto-opened the options menu. All three of those commands routed through a
 * Login module this fork never received, so the upsell pointed at a hang. The
 * commands are gone and so is the upsell; the limit text itself is unchanged.
 */
export function LimitMessage({ text }: { text: string }) {
  if (
    text.startsWith(PROVIDER_LIMIT_PREFIX) ||
    text.startsWith(QUOTA_EXHAUSTED_PREFIX)
  ) {
    return <ProviderLimitMessage text={text} />
  }
  return (
    <MessageResponse>
      <Text color="error">{text}</Text>
    </MessageResponse>
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
