---
name: upsell-commands-missing-login
description: RESOLVED 2026-09-15 — /upgrade, /extra-usage and /rate-limit-options were deleted; kept as the record of why, and of the auto-open that made the third one worse than the other two
type: project
---

**Status: removed on the dead-code cleanup branch
([[dead-code-cleanup-2026-09-15]]).** The product call this memory was waiting
on since 2026-08-06 was made: they are Anthropic consumer-billing surfaces in a
project that is not affiliated with Anthropic, and all three were a hang rather
than a feature. Do not go looking for them.

What was wrong: `upgrade.tsx` and `extra-usage.tsx` both imported `Login` from
`../login/login.js`, and `src/commands/login/` never existed in this fork. The
build's missing-module pre-scan served `() => null`, so `<Login …/>` rendered
nothing and its `onDone` never fired — the command sat in its running state with
a blank body until Ctrl-C.

**The part that was not in the original note:** `/rate-limit-options` was the
worst of the three, because nobody had to type it. `RateLimitMessage`
auto-submitted the command from the transcript the moment a subscription limit
was hit (`REPL.tsx`, `handleOpenRateLimitOptions`), and both of its menu actions
routed into the same dead Login. So hitting a rate limit opened a dialog that
could not be completed.

Removed with them, because their only remaining job was to name those commands:
`RateLimitMessage` and its upsell line, the `onOpenRateLimitOptions` prop drilled
through six components, and the referral / guest-passes / overage-credit /
`/passes` / desktop-upsell cluster around them.

**What replaced the behaviour:** nothing for the upsell; the limit *message* is
unchanged. `LimitMessage` (`src/agent/ui/messages/ProviderLimitMessage.tsx`)
keeps the live countdown for a provider limit and renders anything else — the
Anthropic subscription limit included — as recorded.
