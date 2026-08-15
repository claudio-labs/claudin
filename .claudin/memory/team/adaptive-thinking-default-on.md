---
name: Adaptive thinking is now the default (was opt-in)
description: 2026-07-13 default flip — Claude models send {type:'adaptive'} thinking by default instead of {enabled,budget_tokens}; opt out with CLAUDIN_ENABLE_ADAPTIVE_THINKING=0
type: project
---

Claudin now sends `thinking: {type:'adaptive'}` by default for models that support it (opus-4-8/4-7/4-6, sonnet-5, fable-5, sonnet-4-6). Previously it defaulted to `{type:'enabled', budget_tokens:<from /effort>}` and only used adaptive when `CLAUDIN_ENABLE_ADAPTIVE_THINKING` was truthy. Now the env var is opt-**out**: unset/`1` → adaptive, `0`/`false`/`no`/`off` → back to /effort budget mode.

**Why:** budget-mode thinking burned a fixed budget (8192 at effort=high) even on trivial turns, so the first *visible* answer token was delayed ~2s vs Claude Code. Measured via tmux frame-timing on `-p "olá"`: time-to-first-answer dropped from 3.5–4.2s → 1.4–1.9s (Claude Code is 1.7–2.2s). Raw HTTP TTFB was misleading here — with budget thinking the first bytes are thinking deltas, so TTFB looked fine while the answer lagged. Adaptive lets the model spend ~0 thinking on a greeting.

**How to apply:** The real request selection is `src/providers/shims/claude/streaming.ts` (~line 904), gated by the shared `isAdaptiveThinkingEnabled()` in `src/agent/context/thinking.ts` (also used by the spinner display helper `modelWouldUseAdaptiveThinking`, so they stay in sync). Scope is the Claude-native path only (openaiShim unaffected) and only models where `modelSupportsAdaptiveThinking` is true. `modelRequiresAdaptiveThinking` (fable-5/sonnet-5) still forces adaptive over any opt-out — budget-mode 400s there. Do NOT change support detection (`modelSupports*`) without the model-launch DRI note; the default flip is a separate product decision.

Verify the emitted block by capturing `/v1/messages` through mitmproxy (see mitmproxy-rust-binary-recipe): `bun run build` then `claudindev -p "olá"` with HTTPS_PROXY + NODE_EXTRA_CA_CERTS → expect `{"type":"adaptive"}`; with `CLAUDIN_ENABLE_ADAPTIVE_THINKING=0` → `{"budget_tokens":8192,"type":"enabled"}`.

Related: the spinner's live token counter (`↓ N tokens`) is gated behind `SHOW_TOKENS_AFTER_MS = 3_000` AND `totalTokens>0` (visible response text only) in `src/terminal/spinner/SpinnerAnimationRow.tsx` — it counts visible answer chars/4, not thinking tokens, so short turns never show it. Cosmetic, untouched by this change.
