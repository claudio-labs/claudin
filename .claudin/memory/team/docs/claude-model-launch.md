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
capture). Templates: #237 (`e93a66cc`, Opus 5 → 5.5), #267 (`accf40ee`, Sonnet 5.5 as the
default Sonnet, 2026-09-29), and #348 (`b6d9c03e`, Fable 5.2, 2026-11-10, Claude Code 2.1.322 —
`docs/tech/fable-5-2/wire-capture.md`, the closest template for a version bump inside a tier).

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
- Policy so far: the tier's 1P default and its alias move to the new model. The overall 1P
  default follows Claude Code's catalog `best`: Fable 5.2 moved `fable` while Opus 5.5 stayed
  the default (#348). 3P defaults stay where Claude Code's `per_provider` map keeps them
  (Sonnet 4.5 on Bedrock/Vertex/Foundry). A model that enforces preserved thinking goes in
  `modelSupportsThinkingBlockBinding`.
- This account predates 2026-08-31, so the preserved-thinking 400 cannot be reproduced on it:
  a green `strip` replay proves nothing about enforcement.
- Haiku 5.5 (2026-10-07, Claude Code 2.1.293) inverted the trap: its id contains no older id,
  but every predicate reading `haiku` as "small legacy model" matched it (effort, adaptive
  thinking, 1M, tool search, max output). It is also the 1P small fast model, so side
  queries reach it: replayed `temperature: 0` / `top_p` are a 400, hence
  `modelRejectsSamplingParams`. First tiered price: `ModelCosts.longPrompt` (>100K prompt).
  To capture against a Claude Code newer than the installed one, `npm pack` its
  `-linux-x64` package and put it first on PATH.
- Fable 5.2 (2026-11-10) added three traps:
  - **mise.** `which claude` resolves to `/usr/bin/mise`, so the catalog read came out
    empty. The capture now refuses to run. Use
    `PATH=~/.local/share/mise/installs/claude/latest:$PATH`.
  - **The user's `settings.json` pins `effortLevel: "high"`.** A live wire check of a
    model's default effort needs a throwaway `CLAUDIN_CONFIG_DIR` with a dummy Anthropic
    profile, run with `--bare`. The 401 does not matter; the proxy keeps the body.
  - **Do not run `codegen:reasoning-catalog` inside a launch PR.** On 2026-11-10 it brought
    about 300 lines of unrelated models.dev drift, dropped endpoints included. The runtime
    refresh already lists new models.
- Claude Code also migrates pins between versions (`fable51ToFableAlias`). Grep the
  binary for `migration_` before deciding whether Claudin needs one.
- `claudeCodeParity.test.ts` lists the fixture models and the `TIERS` names by hand. A new
  fixture means editing both.

**Start here when:** a new Claude model ships.

**Kept in sync by:** each launch PR — commit its fixtures and extend this list.
