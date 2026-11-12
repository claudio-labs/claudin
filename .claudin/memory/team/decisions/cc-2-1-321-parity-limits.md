---
name: cc-2-1-321-parity-limits
description: What #347 (v1.2.0, 2026-11-10) deliberately did NOT copy from Claude Code 2.1.321 — per-turn effort (beta per-turn-control) not sent because a top-level effort change already keeps the cache; Agent "When to use" failed its placebo A/B; forked skills go background only on opt-in; a ws Monitor always asks; cron jitter stays 10% / 15 min
type: project
scope: tools, providers/effort
impact: rejected
---

**Decision:** #347 ports Claude Code 2.1.321's tool changes only where they hold for Claudin's
tools. Five of CC's behaviors were measured or chosen against, and they stay out.

**Rejected:**
- **Per-turn effort on the wire.** CC moves the top-level effort to the turn's and adds
  `{role:"system", content:[], output_config:{effort}}` after the user turn (beta
  `per-turn-control-2026-07-01`, an alias of the documented
  `mid-conversation-output-config-2026-07-01`). Its ultrathink is a real `xhigh` turn. Claudin
  sends neither, and its ultrathink stays a text reminder. `scripts/bench/tokens/per-turn-effort-probe.ts`
  (2026-11-09, on the user's login) found both betas accepted on Opus 5.5, Opus 5, Fable 5.1,
  Sonnet 5.5 and Haiku 5.5; without a header the API returns 400 "Extra inputs are not permitted".
  But the control arm, which is today's wire with the top-level effort changed and no system
  message, read the whole previous prefix on Sonnet 5.5 and Opus 5.5, exactly like both per-turn
  layouts. The docs say "a top-level change restarts the cache", and that did not hold, so the
  beta buys nothing. The user chose to send neither.
- **Agent "When to use"** (CC's cost paragraph). delegation-steer-ab on Sonnet 5.5 high, N=3
  with a placebo arm (`/tmp/delegation-steer-ab/20261109-232035`): correct answers 5 against 6
  (the gate failed) and cost −0%. The placebo moved delegation +25 pp and cost −13%, so the noise
  was larger than any effect. Sonnet 5.5 delegated 0–1 of 4 multi-hop questions in every arm.
- **Forked skills in the background by default.** CC backgrounds every `context: fork` skill
  unless it says `background: false`. Here it takes `background: true`, the way an Agent goes to
  the background only when asked. It stays inline wherever nothing could drain it (a sub-agent,
  `-p`, background tasks off; [[only-main-owns-background-agents]]). A typed `/skill` stays in
  the foreground in both CLIs.
- **A stored allow rule for a `ws` Monitor.** It always asks "Monitor will open a WebSocket to
  <url>" and offers no rule. A mode that allows without asking (bypass, a tool-wide rule, auto)
  still allows it. That was the user's call.
- **Cron jitter at 50% / 30 min.** It stays at 10% / 15 min, also the user's call. CC's wider
  jitter spreads load on its own API.

**Why:** parity only where it is true of Claudin's tools. A behavior lever ships only through
an A/B with a placebo arm, and a wire lever only when a probe shows it pays.

**What changes for a teammate:** a re-capture that shows CC's per-turn `output_config` or the
"When to use" paragraph is not a parity gap to close. Re-run the probe, or the A/B with its
placebo, first. Do not flip `background` to default-on, or offer a stored rule for ws monitors,
without asking the user.

**Evidence:** [[claude-code-2.1.321-tool-diff]] has the capture, what was ported and the review
round. Plan `robust-greeting-hoare`; session 646ed873 (2026-11-09).
