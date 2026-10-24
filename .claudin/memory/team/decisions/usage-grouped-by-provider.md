---
name: usage-grouped-by-provider
description: Since 2026-10-22 /usage has a chip per provider profile with that profile's limits and spend, spend is recorded per profile, older spend is attributed by model name as an estimate, and limit alerts name the provider first
type: project
scope: providers/usage, agent/cost-tracker, platform/settings/ui, platform/notifications
impact: functional
paths:
  - "src/providers/usage/providerLimits.ts"
  - "src/providers/usage/providerAttribution.ts"
  - "src/platform/settings/ui/usageLines.ts"
  - "src/providers/rateLimitMessages.ts"
---

**Decision:** /usage is grouped by registered provider profile, the way CodexBar is. It shows
`All │ <profile> │ … │ <active> ●` chips, stepped with `[`/`]` (←/→ stay on the Settings tabs).
Each chip shows that profile's limits, read for it whichever profile is active, and what it
spent in the project.
- **Recording:** the cost tracker records spend per profile id in `providerUsage`. It is folded
  and persisted like the per-model totals, and restored from both the project slot and the
  transcript `cost-state`.
- **Older spend:** anything recorded before has only its model. It is attributed by name in
  `providerAttribution.ts` and shown with a `~`. The order is: a model the profile is
  configured with, then a vendor-prefixed id, then the family's own backend (`claude-*`,
  `gpt-*`), then the only profile whose discovered list has it, otherwise Others.
- **Limits table:** one capability table (`PROVIDER_LIMITS`) says who reports limits: Claude
  subscription, Codex, MiniMax. `fetch` serves /usage and `live` serves the REPL alert. A new
  provider is one row plus its reader.
- **Alerts:** they name the provider first, as its chip reads:
  `Anthropic · weekly ▰▰▰▰▰▰▰▰▰▱ 92% · resets … (in 2d 4h)` and
  `Codex OAuth · 5h limit reached · …`. Codex warns at 75/90/95% from its own response headers
  and socket event. The footer keeps a high or reached window until it resets.

**Why:** the user asked for it with CodexBar screenshots as the spec (2026-10-22). Before, /usage
was one flat model list across every provider, and only the active provider's limits showed.

**What changes for a teammate:**
- Transcript routing of limit messages is by shape (`isRateLimitErrorMessage`): any profile
  name, then a limit name the formatters write. A new limit name must be added to
  `LIMIT_NAMES`, or its message renders as plain text.
- Attribution was kept by the evidence, not by the review's suggestion. The user's OpenCode GO
  gateway lists `claude-haiku-5-5`, whose spend was Anthropic's, so a discovered listing does
  not beat the family. `kimi-k3` is OpenCode GO's catalog id, not Moonshot's, so no `kimi-*`
  rule was added.
- Kimi Code and OpenCode GO have plan quotas but no limits reader yet. That was deferred on
  purpose.
- `scripts/migrations/probes/usageByProvider.json` (coverage net) and
  `usageByProviderReviewFixes.json` (one mutation per review fix) prove the tests.

**Evidence:** PR #316 (branch `feat/usage-by-provider`, plan `squishy-whistling-milner.md`). The
wire facts are in [[codex-0.162-wire-diff]].
The live-check recipe is in [[tmux-mouse-click-verification]].
