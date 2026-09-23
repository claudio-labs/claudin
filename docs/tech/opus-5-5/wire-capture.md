# Claude Opus 5.5 — captured wire format

What Claude Code actually sends for `claude-opus-5-5`, captured before
registering the model in Claudin so the implementation has a target instead of
an inference from the docs. Same idea as
[`docs/tech/kimi-code/wire-format.md`](../kimi-code/wire-format.md), except this
one is a first-party model and the capture is reproducible from this repo.

- **Captured** 2026-09-22 against **Claude Code 2.1.280** and Claudin on
  `feat/opus-5-5` (before any source change).
- **How**: `bun run scripts/bench/tokens/wire-diff.ts --model=claude-opus-5-5 --a=claude --b=claudindev --full --raw`
- **Where**: full bodies land in `/tmp/wire-A.json` (Claude Code) and
  `/tmp/wire-B.json` (Claudin).

## Reviving the harness

`wire-diff.ts` had carried a `STATUS 2026-07-26: BROKEN` note blaming the
injected `ANTHROPIC_API_KEY`. That diagnosis was wrong. The mock server and the
CLI ran in **one process** and the CLI was launched with `spawnSync`, which
blocks the event loop for the child's whole lifetime — the TCP connection sat in
the accept backlog, JS never serviced it, and the CLI was SIGTERM'd at the
timeout with zero captures. Claude Code's own `--debug-file` shows both halves:

```
[API REQUEST] /v1/messages source=sdk
Slow first byte: no stream chunk 30.0s after request sent (attempt 1)
```

The fix is an async `spawn` plus an awaited exit. Three smaller things also had
to change, and each of them had been silently shaping the numbers:

- `CLAUDECODE`, `CLAUDE_CODE_*` and `CLAUDIN_*` leak from whichever
  Claude-Code-family CLI runs the script into the CLI under test.
  `CLAUDIN_DISABLE_EXPERIMENTAL_BETAS=true` in the parent session removed three
  betas from the child's header, which reads as a fork divergence that is not
  there. The harness now strips the whole family.
- The two CLIs resolve auth **differently** under `--bare`: Claude Code reads
  `ANTHROPIC_API_KEY` from the environment, while Claudin's bare mode reads only
  the active Anthropic profile's `apiKey` or an `apiKeyHelper`
  (`src/providers/auth/auth.ts:228-243`) and never the env var. On a machine
  whose `/provider` is unconfigured — the default OAuth setup — a bare Claudin
  run exits 1 with `Not logged in · Please run /login`. `--full` drops both the
  bare flags and the injected key so each CLI authenticates as it normally does.
- A CLI that refuses the run prints the reason on **stdout** and exits 1 with an
  empty stderr, which the harness used to report as "did not honor
  ANTHROPIC_BASE_URL".

## The request body

| field | Claude Code 2.1.280 | Claudin, before this branch |
|---|---|---|
| `model` | `claude-opus-5-5` | `claude-opus-5-5` (passed through) |
| `max_tokens` | **128000** | **64000** |
| `thinking` | `{"type":"adaptive","display":"omitted"}` | `{"type":"adaptive"}` |
| `output_config` | `{"effort":"medium"}` | `{"effort":"max"}` (project pin) |
| `context_management` | `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` | absent |
| `safeguards` | `[{"type":"dangerous_tool_use","classifier_context":{…}}]` | absent |
| `temperature` / `top_p` / `top_k` | none sent | none sent |
| `stream` | `true` | `true` |

`anthropic-beta`, Claude Code, OAuth session:

```
claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14,
thinking-token-count-2026-05-13, context-management-2025-06-27,
prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07,
per-turn-control-2026-07-01, mid-conversation-tool-changes-2026-07-01,
advisor-tool-2026-03-01, effort-2025-11-24, dangerous-tool-use-2026-09-03,
afk-mode-2026-01-31, extended-cache-ttl-2025-04-11
```

Claudin's, same run: `claude-code-20250219, oauth-2025-04-20,
interleaved-thinking-2025-05-14, advanced-tool-use-2025-11-20,
extended-cache-ttl-2025-04-11, effort-2025-11-24`.

## What the capture settles

1. **`max_tokens` is the one model-specific bug it found.**
   `getModelMaxOutputTokens` (`src/agent/context/context.ts:216-223`) gives the
   whole `opus-5` family a **default** of 64k against a 128k upper limit, and
   `claude-opus-5-5` matches that branch by substring. Claude Code sends 128k.
   Opus 5.5 needs its own branch *before* the `opus-5` one — the same ordering
   trap that `firstPartyNameToCanonical` documents for `claude-fable-5-1`.

2. **`thinking` carries `display: "omitted"` in the body.** Claudin expresses
   the same intent through the `redact-thinking-2026-02-12` beta header, which
   `getAllModelBetas` gates on an interactive session
   (`src/providers/transport/betas.ts:263-275`) — so a headless `-p` capture
   never shows it. Not a divergence to "fix" from this capture alone.

3. **Claude Code does NOT send `thinking-binding-controls-2026-08-01`, and
   sends no `block_binding`.** It does not need the escape hatch, because it
   does not rewrite history client-side: `context_management.edits` hands
   thinking management to the **server** with `keep: "all"`. Claudin does the
   opposite — `applyStubs` rewrites old `tool_result` blocks in place and
   `stripOldThinkingBlocks` removes thinking from the middle of the history —
   which is exactly what invalidates a preserved-thinking prefix. The guard is
   still the right call for Claudin, but it is a Claudin-specific need and the
   commit should say so rather than implying it mirrors upstream.

4. **Effort.** Claude Code sent `medium` on both the `--bare` and the `--full`
   run, while `~/.claude/settings.json` has `effortLevel: "high"` — evidence
   that it resolves Opus 5.5 to medium regardless. Claudin sent `max` here
   because this project has an effort pin, so the two are not directly
   comparable; the Claudin default for 5.5 is a separate decision.

## After registering the model

Re-running the same command on `feat/opus-5-5`:

| field | Claude Code | Claudin, after |
|---|---|---|
| `max_tokens` | 128000 | **128000** ✔ |
| `thinking` | `{"type":"adaptive","display":"omitted"}` | `{"type":"adaptive","block_binding":{"prefix_mismatch_behavior":"drop_block"}}` |
| sampling params | none | none ✔ |

What is left is not Opus-5.5-specific and was not touched:

- **Claudin's beta header is shorter by design.** `src/platform/entrypoints/cli.tsx:74`
  runs `process.env.CLAUDIN_DISABLE_EXPERIMENTAL_BETAS ??= 'true'`, so every
  header behind `shouldIncludeFirstPartyOnlyBetas()` — `context-management`,
  `prompt-caching-scope`, `redact-thinking`, `thinking-token-count` — is off
  unless the user opts out. That default is what made the first version of the
  block-binding guard inert, and why the header is deliberately ungated: a
  guard against a hard 400 that ships disabled reads as done and is not.
- `context_management` and `safeguards` are Claude Code features Claudin does
- `context_management` IS implemented here (`src/agent/cache/anthropic/apiMicrocompact.ts`
  emits the same `clear_thinking_20251015` edit), but it needs BOTH the retain
  cache profile — `serverToolClearEnabled` is false under aggressive — and the
  `context-management` beta, which is behind the experimental switch above. It
  is off in this capture for the second reason, not missing.
- `safeguards` (the `dangerous_tool_use` classifier context) has no counterpart
  in this fork at all.
- The tool set and system-prompt size differ because the two CLIs are different
  products.

## Turn 2 and beyond — the thinking replay

`scripts/bench/tokens/thinking-replay-capture.ts` answers what the single-turn
capture could not: what a CLI sends once it has a signed `thinking` block in
history that it must echo back. The mock returns a thinking block with a
sentinel signature plus a `tool_use`, so the CLI runs the tool and comes back
carrying its own previous assistant turn. Still no real API calls.

```
bun run scripts/bench/tokens/thinking-replay-capture.ts                       # claude
bun run scripts/bench/tokens/thinking-replay-capture.ts --bin=claudindev --full
CLAUDIN_CACHE_PROFILE=aggressive bun run … --bin=claudindev --full --user-turns=4
```

### Claude Code — identical on all three models

Opus 5.5, Fable 5.1 and Sonnet 5 all produce, on turn 2:

- `thinking: {"type":"adaptive","display":"omitted"}` — **no `block_binding`,
  ever**, and no `thinking-binding-controls` beta
- `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`
- the thinking block echoed back with text and signature byte-identical

So Claude Code's answer to preserved thinking is to not break the prefix in the
first place: echo verbatim, and let the server do thinking management.

### Claudin — it depends on the cache profile, not on the model

Two knobs decide whether Claudin breaks its own prefix, and the model is
neither of them:

| run | signed blocks surviving |
|---|---|
| `--turns=6` (one user turn, five tool steps) | **5/5** |
| `--user-turns=4`, retain profile | **4/4** |
| `--user-turns=4`, `CLAUDIN_CACHE_PROFILE=aggressive` | **1/4** |

- **A tool loop is safe by construction.** `stripOldThinkingBlocks` skips every
  assistant turn belonging to the user turn in flight
  (`src/agent/messages/normalize.ts:2323-2329`), precisely because stripping a
  turn-initial signed block mid-loop is what produces the "thinking blocks
  cannot be modified" 400. A five-step tool loop replays 5/5 under any profile.
- **Past user turns are not.** With four real user turns under the AGGRESSIVE
  profile — what every user without a configured `/provider` gets
  (`src/agent/cache/cacheProfile.ts`) — three of four blocks are gone and six
  assistant turns come back with no thinking block at all.
- The RETAIN profile (an Anthropic `/provider` profile configured) strips
  nothing, which is why a developer machine can read clean while the default
  install is exposed. Always pin `CLAUDIN_CACHE_PROFILE` before concluding.

That measurement is what put **Fable 5.1** under the same guard as Opus 5.5.
It had been left out as the cautious choice — it ships today without the header
— but it is a preserved-thinking model taking the identical 3-of-4 strip, so
"cautious" meant leaving a reachable 400 in place. Sonnet 5 is correctly left
out: it takes the same strip and does not enforce the check.

## Limits of this capture

- The wire-diff half is one turn, `-p hi`, so it sees **no thinking blocks
  replayed**. The replay probe above closes that, without the real API.
- Neither probe exercises the OTHER prefix rewrite: `applyStableStubs`
  restubbing an already-sent `tool_result`. That needs a session large enough
  for the relief clip to fire, which a mock conversation never reaches. The
  block-binding guard covers it by construction, but it is not measured here.
  How large, measured: the age prune (aggressive only) fires per TOOL
  ITERATION, not per session — but only on a result at or above
  `MIN_STUB_TOKENS` (100), and the tool-result summarizer gets there first: a
  7.8 KB Bash output arrives as 508 bytes, so it is never clipped. The relief
  clip needs `sizeStubThresholdFraction` of the window (500k aggressive / 750k
  retain on a 1M model) or retain's 250k of accumulated tool_results. Re-check
  with `--tool-result-bytes=N`.
- Headless `-p`: Claudin's interactive-only betas (`redact-thinking`,
  `thinking-token-count`) are suppressed for being headless — but they are ALSO
  behind the experimental switch, so an interactive default session does not
  send them either. `display: "omitted"` rides on `redact-thinking`, which is
  why Claudin never omits thinking text where Claude Code always does.
- `context_management` and `safeguards` are Claude Code features Claudin does
  not send here. Neither is Opus-5.5-specific and both are out of scope
  here.
