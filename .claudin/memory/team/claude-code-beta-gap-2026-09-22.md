---
name: claude-code-beta-gap-2026-09-22
description: The betas Claude Code 2.1.280 sends and Claudin does not, re-measured on the real first-party path — 9 headless + 1 interactive; the first list had a mock-URL artifact; display is a UX gap, not a cost; what the round adopts, defers, rejects
type: project
paths:
  - src/providers/transport/betas.ts
  - src/shared/constants/betas.ts
---

Measured 2026-09-22 with `scripts/bench/tokens/wire-matrix.ts`: headless and
interactive, Opus 5.5 / Fable 5.1 / Sonnet 5, both CLIs, zero real API calls.
The matrix and Claude Code's gating logic (with bundle anchors) are in
`docs/tech/anthropic-betas/wire-matrix.md`.

**The first version of this memory was wrong in three places, all from one
confound.**
- A localhost `ANTHROPIC_BASE_URL` makes Claude Code classify the session as
  not first-party. Under that classification it:
  - SENDS `safeguards` + `dangerous-tool-use`
  - DROPS thinking-binding-controls, `scope:"global"`, tool search and
    interactive `display:"updates"`
- `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` is its own override. The
  harnesses now set it by default.
- **Never read a Claude Code capture against a mock without it.**

**The gap on the real endpoint (OAuth):**
- Nine headless betas: thinking-token-count, context-management,
  prompt-caching-scope, cache-diagnosis, afk-mode (auto mode), advisor-tool,
  mid-conversation-system, per-turn-control and mid-conversation-tool-changes.
  The last two are Opus 5.5 / Fable 5.1 only, by catalog capability.
- Interactive adds thinking-display-updates.
- dangerous-tool-use is NOT one of them: on the real endpoint it needs
  GrowthBook `smooth_chipmunk`, default false.
- Claude Code sends the thinking-binding-controls header on all three models.
  Only the `block_binding` field sits behind its own flag. Claudin's
  header + `drop_block` on Opus 5.5 / Fable 5.1 stays deliberate, because
  Claudin rewrites its own prefix.

**`thinking.display` is not a cost.**
- `"omitted"` is the server default on the whole Claude 5 family, so Claudin
  already gets empty thinking.
- The docs: omitting "reduces latency, not cost".
- The real gap is UX:
  - Opus 5.5 / Fable 5.1 progress updates are invisible (they need
    `"updates"` + its beta).
  - The spinner's token counter freezes, because thinking-token-count is
    missing.

**afk-mode IS behind `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS`.** The first version
said it was not.

**The switch's "→ 500" claim was never measured.** It came from openclaude
(Gitlawb/openclaude#281). The one Claudin measurement is `scope:"global"`
returning a 400 in May, with auth unrecorded.

**The round, as of 2026-09-22 (in progress on `feat/beta-parity`, not merged):**
- **Adopted**, each behind its own predicate: first-party, a real base URL, and
  a `CLAUDIN_DISABLE_*` killswitch. The set:
  - `display` — `"updates"` interactive, `"omitted"` headless
  - thinking-token-count
  - context-management with `keep:"all"` only
  - prompt-caching-scope
  - cache-diagnosis
  - afk-mode
- **Deferred:** the mid-conversation trio, one `role:"system"` change with its
  own cache A/B.
- **Rejected:** `safeguards`, see [[safeguards-classifier-rejected]].
- **Unchanged:** advisor stays off, effort defaults stay.
- **Also measured:** Sonnet 5 `max_tokens` 32k (Claude Code sends 64k), and the
  switch stripping `eager_input_streaming` from every tool.

Re-measure: `bun run scripts/bench/tokens/wire-matrix.ts capture`, then
`interactive`, then `report --match=-oauth-`. A fresh `bun run build` comes
first.

Related: [[defingerprinting-branch-2026-08]], [[anti-narration-never-benched-on-claude-5]]
