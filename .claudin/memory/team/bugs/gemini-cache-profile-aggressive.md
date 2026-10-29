---
name: gemini-cache-profile-aggressive
description: Gemini resolves to the 'aggressive' cache profile (readMult 1.0, age-clips early) although Google bills a cache read at 0.1x input, like Anthropic; found 2026-10-28, A/B owed before flipping to 'retain', not fixed
type: project
paths:
  - "src/agent/cache/cacheProfile.ts"
---

**Symptom:** on a Gemini profile the relief policy clips old tool results early and
rewrites the prefix, the behaviour meant for providers whose cache gives little back.

**Where:** `resolveProfileForProvider` (`src/agent/cache/cacheProfile.ts`) returns
`retain` only for Anthropic-style transports, Codex, Copilot, DeepSeek and
`api.openai.com`; `gemini` falls through to `aggressive` (`readMult: 1.0`). The header
comment calls Gemini "~2-4:1", but `modelCost.ts` prices its cache read at 0.1x input,
and Google's pricing page agreed on 2026-10-28 (e.g. 3 Flash 0.50 in, 0.05 cached).

**Why it is not just flipped:** each clip on Gemini is a prefix rewrite, so retain
should win, but nothing has measured it. Plan agreed with the user: a 3-arm
`session-cache-ab` (aggressive / retain / placebo) on `gemini-3-flash-preview`, N=3,
~US$5, flipped only on a measured win; without one, the comment is corrected and the
test pins `aggressive` with the number. A red test ("gemini gets the retain profile",
`cacheProfile.test.ts`) was written and kept out of the Gemini-native PR because the
A/B had not run.

**Run it after the native transport lands:** before it, Gemini sized
`gemini-3-flash-preview` at the 128k fallback and compacted ~8× early, which would have
skewed both arms ([[gemini-native-transport]]).
