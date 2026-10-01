---
name: claude-model-launch
description: Adding a new Claude model starts from the launch capture and the parity fixtures, with the Opus 5.5 and Sonnet 5.5 launch PRs as templates — not from a grep for the previous id
type: reference
paths:
  - src/providers/model/claudeCodeParity.test.ts
  - src/providers/model/model.ts
---

**Doc:** `scripts/bench/ab/model-launch-capture.ts` (header: the three-turn capture, the four
thinking replays, the harness traps) and `docs/tech/opus-5-5/wire-capture.md` (the first launch
capture). Templates: #237 (`e93a66cc`, Opus 5 → 5.5) and #267 (`accf40ee`, Sonnet 5.5 as the
default Sonnet, 2026-09-29).

**Covers:**
- The sites: 41 `@[MODEL LAUNCH]` markers across 23 files (2026-09-29).
- The trap every launch hits: the new id CONTAINS the previous one (`claude-sonnet-5-5` ⊃
  `claude-sonnet-5`), so capability predicates (`includes('sonnet-5')`) already fire, while
  every site that resolves a VERSION — canonical name, marketing name, cutoff, commit
  attribution, 3P fallbacks, the Bedrock profile match — needs the new branch placed first.
  Gateways send dotted ids (`claude-sonnet-5.5`), handled in the canonicalizer.
- Parity: `--fixtures` writes Claude Code's request shape and its baked catalog entry (default
  effort, cutoff, max output, pricing tier) to `src/providers/model/__fixtures__/claude-code-wire/<cc version>/`;
  `claudeCodeParity.test.ts` asserts Claudin against them — run it RED before the source change.
- Policy so far: the 1P default moves to the new model; 3P defaults stay where Claude Code's
  `per_provider` map keeps them (Sonnet 4.5 on Bedrock/Vertex/Foundry); a model that enforces
  preserved thinking goes in `modelSupportsThinkingBlockBinding`.
- This account predates 2026-08-31, so the preserved-thinking 400 cannot be reproduced on it:
  a green `strip` replay proves nothing about enforcement.

**Start here when:** a new Claude model ships.

**Kept in sync by:** each launch PR — commit its fixtures and extend this list.
