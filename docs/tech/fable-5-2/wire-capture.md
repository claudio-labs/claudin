# Claude Fable 5.2 — captured wire format

What Claude Code sends for `claude-fable-5-2`, captured before the model was
registered in Claudin, next to the same request for `claude-fable-5-1`.

- **Captured** 2026-11-10 against **Claude Code 2.1.322** (published
  2026-11-10 01:58Z, the day after the model launched).
- **How**: one `claude -p oi` per model through
  `scripts/bench/ab/wire-proxy.ts`, with `proxyEnv()` so the session stays on
  the first-party path. Then `model-launch-capture.ts --models=claude-fable-5-2
  --hard --effort=high --fixtures=src/providers/model/__fixtures__/claude-code-wire`
  wrote the committed fixture.
- **Trap**: under mise, `which claude` is a symlink to `/usr/bin/mise`, so the
  capture read the catalog out of the wrong binary. It now refuses to run.
  Put the install directory first:
  `PATH=~/.local/share/mise/installs/claude/latest:$PATH`.

## The request, 5.1 against 5.2

| Field | Fable 5.1 | Fable 5.2 |
|---|---|---|
| betas (17, thinking-binding-controls included) | same | same |
| `thinking` | `{adaptive, omitted}` | same |
| `context_management` | `clear_thinking`, `keep: "all"` | same |
| tools, `cache_control` layout | 13 tools | same |
| `max_tokens` | 64000 | **128000** |
| `output_config.effort` (top level and per turn) | high | **medium** |
| system prompt | the 5.1 bundle, 11.3k chars | **the 5.2 bundle**, 10.0k chars |
| Bash tool description | — | **one more line**: avoid `cat`, `head`, `tail`, `sed`, `awk`, `echo` |
| env and commit attribution | Fable 5.1 | Fable 5.2 |

The knowledge cutoff in the env block is June 2026 for both.

All four thinking replays returned 200 on 5.2: control, `block_binding` alone,
a stripped prefix, and a stripped prefix with `block_binding`. The account
predates 2026-08-31, so a green strip does not show whether 5.2 enforces
preserved thinking. It does show that the field is accepted.

## The catalog entry

Read out of the 2.1.322 binary:

- `display_name: "Fable 5.2"`, `knowledge_cutoff: "June 2026"`.
- `fallback_3p: "claude-fable-5-1"`.
- `max_output_tokens: {default: 128000, upper: 128000}`.
- `pricing: "tier_8_40_cache_read_0_20"`: $8 input, $40 output, $10 and $16
  cache writes (5m and 1h), $0.20 cache read.
- `default_effort: "medium"`.
- Capabilities that 5.1 has and 5.2 does not: `fable_5_mitigations`,
  `fable_5_1_prompt_bundle`, `total_tokens_reminder`, `tool_loaded_text`.
- Capabilities that 5.2 has and 5.1 does not: `fast_mode`, `vertex_fast_mode`,
  `org_locked_thinking`, `fable_5_2_prompt_bundle`.
- The alias table points `fable` at `claude-fable-5-2`. `best` stays `opus`,
  and no default model moves.

## What Claudin took, and what it left

Taken:
- Canonical name, display and marketing names, and cutoff.
- Price, 128K output, and `medium` default effort on first party.
- Thinking binding.
- The `fable` alias.
- The 3P fallback to 5.1.
- The Vertex region variable, plus the missing 5.1 one.
- Exemption from the cyber-risk read reminder. Claude Code 2.1.322 sends that
  reminder to no model at all.
- The pin migration (below).

Left for a follow-up:

- **The 5.2 prompt bundle.** Claudin keeps one system prompt for every Claude
  model, and steering changes here need an A/B before they ship.
  - 5.1 bundle sections the 5.2 bundle drops:
    - The "say in a line what you're about to do" opener.
    - "# Delivering work" and "# Writing for the user".
    - The "operating autonomously" paragraph.
    - "Before ending your turn" and "Before running a command that changes
      system state".
  - Sections the 5.2 bundle adds:
    - An identity paragraph: Fable 5.2 and Mythos 5.2 share one model.
    - A training note. Work like accelerator kernel optimization was limited,
      so the model should trust its preconceptions less there and look up
      documentation more.
    - Original-games guidance and "# Finishing work".
    - A note that Edit works in the working directory without a prior Read.
    - "# Memory, notes and feedback".
    - "Don't create planning documents unless asked".
- **Fast mode.** Claude Code prices fast Fable 5.2 at $16 input, $80
  output, $20 and $32 cache writes, and $0.40 cache read. Claudin's `/fast`
  still switches to Opus 5.5. Supporting Fable here means `/fast` has to keep
  the current model, and nothing in this round could check that live.
- **The new Bash line.** Claudin's Bash prompt already sends the reader to the
  dedicated tools.
- **The org-locked thinking warning, and a nudge toward medium effort for 5.1
  users.** Both sit behind remote flags. The warning's flag defaults to off.

## The pin migration

Claude Code 2.1.322 moves `userSettings.model` from `claude-fable-5-1` (or
`claude-fable-5-1[1m]`) to `fable`. It does this on first party only, and only
when the alias is available. For team and enterprise organizations it defers
the move until entitlement checks pass, up to 2026-12-15.

`migrateFable51ToFableAlias` does the same with two differences:
- It also moves the per-project `/model` pin, when the profile that pin was made
  under is first party.
- It does not defer. Claudin has no entitlement cache to wait on.

## After registering the model

`claudindev -p oi` through the same proxy. The run used a throwaway config dir
holding a dummy Anthropic profile, so no effort pin applied. The responses were
401s. Only the request bodies are evidence here.

| `--model` | model sent | `max_tokens` | effort | `block_binding` |
|---|---|---|---|---|
| `fable` | `claude-fable-5-2` | 128000 | medium | `drop_block` |
| `claude-fable-5-1` | `claude-fable-5-1` | 64000 | high | `drop_block` |
| `claude-opus-5-5` (control) | `claude-opus-5-5` | 128000 | medium | `drop_block` |

A global `effortLevel` in `settings.json` still wins over the model default.
With one set to `high`, Fable 5.2 goes out at `high`.

## Limits of this capture

- Preserved-thinking enforcement is unmeasured, for the account-age reason
  above.
- `reasoningCatalogData.ts` was not regenerated. A full regeneration on
  2026-11-10 brought about 300 lines of unrelated drift, dropped endpoints
  included. The runtime refresh (`reasoningCatalogRefresh.ts`) already lists
  `claude-fable-5-2` from models.dev.
- On Bedrock and Vertex, `modelSupportsThinking` has no Fable branch
  (`src/agent/context/thinking.ts`). By reading the code, no Fable request
  carries `thinking` there, 5.1 included. Not run.
