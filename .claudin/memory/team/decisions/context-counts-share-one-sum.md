---
name: context-counts-share-one-sum
description: Since 2026-10-22 the footer warning, status line, /context and plan-exit dialog read the count autocompact fires on; status line used_percentage now includes output tokens, unlike Claude Code
type: project
scope: agent/context, agent/compact, agent/attachments
impact: functional
paths:
  - "src/agent/context/usageTokens.ts"
  - "src/agent/context/context.ts"
  - "src/agent/context/analyzeContext.ts"
  - "src/terminal/prompt-input/Notifications.tsx"
---

**Decision:** one measure of how full the window is. `getTokenCountFromUsage`
(`src/agent/context/usageTokens.ts`, input + cache + output of the last response) is the sum
everywhere. Autocompact, relief and the footer warning read `tokenCountWithEstimation` (that sum
plus an estimate of what arrived since). The status line, `/context` and the plan-exit dialog
read the sum alone. At rest all of them agree with the trigger. `/context` draws its autocompact
buffer from `getAutoCompactThreshold`, so `CLAUDIN_AUTOCOMPACT_PCT_OVERRIDE` shows there too.

**Why:** before, the footer used only the last response, the status line and `/context` left out
output tokens, and `/context` ignored the override. The numbers on screen could disagree with
each other and with when compaction actually fired.

**What changes for a teammate:**
- The status-line JSON `context_window.used_percentage` includes `output_tokens`. Claude Code's
  does not. User status-line scripts see a slightly higher number. The user chose this on
  2026-10-22.
- Mid-turn the status line still lacks the trailing estimate, so it can trail the footer until
  the next response.
- `output_tokens` includes thinking. A model that drops earlier turns' thinking reads less back,
  so there the count is high. This is documented on the function and not corrected.
- `scripts/migrations/probes/contextUsageAndScratchpad.json` breaks each piece. The wiring in
  the React-Compiler components is pinned on source text in `contextUsage.test.ts`.

**Same branch, same day:**
- The output-style reminder goes once per prompt (`input !== null` in `pipeline.ts`), not after
  every tool batch. Accepted loss: a turn that starts with an image-only paste, or a prompt
  queued mid-turn, gets no reminder. The system prompt still carries the style.
- Session-memory compaction was removed. Its writer had been dead since `27c85f20`, so
  `ENABLE_CLAUDE_CODE_SM_COMPACT` only made every compaction look for a file nothing wrote.
- The scratchpad section is keyed by session id, and `init()` subscribes a mkdir on session
  switch. Before, `/clear`, `/new` and `/resume` kept announcing the previous session's path.

**Evidence:** branch `fix/context-scratchpad-and-session-memory`. Open findings from the same
audit are in [[context-audit-2026-10-22-open-findings]].
