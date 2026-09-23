# Anthropic betas — what Claude Code sends, measured

What Claude Code 2.1.280 actually puts on the wire for Claude Opus 5.5, Claude
Fable 5.1 and Claude Sonnet 5, next to what Claudin sends, captured before the
beta round of 2026-09-22 changed anything. It supersedes the beta and
`safeguards` findings of [`../opus-5-5/wire-capture.md`](../opus-5-5/wire-capture.md),
whose capture had a confound (next section).

- **Captured** 2026-09-22: Claude Code **2.1.280** against Claudin at
  `e93a66cc` (main after #237), OAuth login (Claude Max), a throwaway cwd.
- **How**: `scripts/bench/tokens/wire-matrix.ts` — `capture` for headless `-p`,
  `interactive` for the TUI (driven through a private tmux server), `report`
  for the matrix. Every header and the whole body of every request, against a
  local mock, credentials redacted. **Zero real API calls.**

## The confound in the #237 capture

Pointing `ANTHROPIC_BASE_URL` at a localhost mock is not neutral for Claude
Code. Its first-party check is a host allowlist
(bundle anchor `return["api.anthropic.com"].includes(t)`), so the mock session
is classified as **not first-party**, and that changes what it sends:

| | mock base URL, as in #237 | `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` |
|---|---|---|
| `safeguards` body + `dangerous-tool-use-2026-09-03` | sent | **not sent** |
| `thinking-binding-controls-2026-08-01` | not sent | **sent, all 3 models** |
| `advanced-tool-use-2025-11-20` (tool search, `defer_loading`) | not sent, 67 tools inline | **sent**, 12–16 tools |
| `cache-diagnosis-2026-04-07` + `diagnostics` body | not sent | **sent** |
| `scope:"global"` on the static system block | no | **yes** |
| interactive `display:"updates"` | no | **yes** |

`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` is Claude Code's own override for
this. The harnesses set it by default (with `CLAUDIN_ASSUME_FIRST_PARTY_BASE_URL`
for Claudin, which this round adds), and `--no-assume-1p` turns it off.
So the `safeguards` payload #237 reported, and its "Claude Code does not send
thinking-binding-controls", were both properties of the mock, not of the
endpoint.

## Betas, OAuth

✓ sent · – not sent. "Claudin" is the same in `-p` and interactive.

| beta | CC `-p` | CC interactive | Claudin | CC sends it for |
|---|---|---|---|---|
| `claude-code-20250219` | ✓ | ✓ | ✓ | all three |
| `oauth-2025-04-20` | ✓ | ✓ | ✓ | all three |
| `interleaved-thinking-2025-05-14` | ✓ | ✓ | ✓ | all three |
| `effort-2025-11-24` | ✓ | ✓ | ✓ | all three |
| `extended-cache-ttl-2025-04-11` | ✓ | ✓ | ✓ | all three |
| `advanced-tool-use-2025-11-20` | ✓ | ✓ | ✓ | all three |
| `thinking-binding-controls-2026-08-01` | ✓ | ✓ | Opus 5.5, Fable 5.1 | all three |
| `thinking-token-count-2026-05-13` | ✓ | ✓ | – | all three |
| `context-management-2025-06-27` | ✓ | ✓ | – | all three |
| `prompt-caching-scope-2026-01-05` | ✓ | ✓ | – | all three |
| `cache-diagnosis-2026-04-07` | ✓ | ✓ | – | all three |
| `afk-mode-2026-01-31` | ✓ | ✓ | – | all three (auto mode was active) |
| `advisor-tool-2026-03-01` | ✓ | ✓ | – | all three; the tool itself only for Opus 5.5 / Fable 5.1 |
| `mid-conversation-system-2026-04-07` | ✓ | ✓ | – | all three |
| `per-turn-control-2026-07-01` | ✓ | ✓ | – | Opus 5.5, Fable 5.1 |
| `mid-conversation-tool-changes-2026-07-01` | ✓ | ✓ | – | Opus 5.5, Fable 5.1 |
| `thinking-display-updates-2026-08-18` | – | ✓ | – | all three |
| `dangerous-tool-use-2026-09-03` | – | – | – | none on the real endpoint (mock artifact) |

So headless there are **nine** betas Claude Code sends and Claudin does not,
and interactive adds a tenth. They are not the nine #237 listed:
`dangerous-tool-use` is out and `cache-diagnosis` is in.

Interactive Claude Code also sends one `claude-haiku-4-5-20251001` request with
`max_tokens: 1` at startup. That is its quota probe, which reads the
`anthropic-ratelimit-unified-*` headers. It is skipped in `-p`, for
non-subscribers, and in essential-traffic mode.

### With an API key

Claude Code with `ANTHROPIC_API_KEY` and the normal session sends the same set
minus `oauth-2025-04-20` and `extended-cache-ttl-2025-04-11` (its cache TTLs
drop to 5m). For Opus 5.5 and Fable 5.1 it adds a `fallbacks` body field with
`server-side-fallback-2026-07-01` and `fallback-credit-2026-06-01`: that is
server-side model fallback on a refusal. No Claudin column here: with an OAuth
login present, Claudin ignored the env key and sent `oauth-2025-04-20` anyway.

## Body fields

| field | CC `-p` | CC interactive | Claudin |
|---|---|---|---|
| `thinking` | `{"type":"adaptive","display":"omitted"}` | `{"type":"adaptive","display":"updates"}` | `{"type":"adaptive"}`, plus `block_binding: drop_block` on Opus 5.5 / Fable 5.1 |
| `context_management` | `{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` | same | absent |
| `diagnostics` | `{"previous_message_id":null}` on turn 1 | same | absent |
| `max_tokens`, Opus 5.5 / Fable 5.1 / Sonnet 5 | 128000 / 64000 / 64000 | same | 128000 / 64000 / **32000** |
| `output_config.effort`, same order | medium / high / high | same | high / high / high here — this machine's settings; the code defaults are high / high / medium |
| `eager_input_streaming` on tools | 11–17 tools | same | **0 of 38–41** |
| system `cache_control` | `[-, -, 1h/global, 1h]` | same | `[-, 1h, 1h]` |
| `role:"system"` messages | environment text + `tool_addition` blocks + `output_config` (Opus/Fable) | same | none |

Claudin's zero `eager_input_streaming` is its own switch at work:
`CLAUDIN_DISABLE_EXPERIMENTAL_BETAS` (defaulted on in `cli.tsx`) strips tool
schemas down to name, description, schema and cache control, which also
cancels the fine-grained tool streaming that `cli.tsx` turns on a few lines
later. Sonnet 5's 32000 is `getModelMaxOutputTokens` falling through to its
default branch: no `sonnet-5` case exists.

## Thinking display, from the API docs

From [platform.claude.com — Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
"Controlling thinking display" and "Progress updates between tool calls":

- `display` takes `"summarized"`, `"omitted"` and `"updates"` (beta).
  `"omitted"` "is the default on Claude Fable 5.1, Claude Mythos 5.1, Claude
  Fable 5, Claude Mythos 5, Claude Opus 5.5, Claude Opus 5, Claude Sonnet 5,
  Claude Opus 4.8, Claude Opus 4.7". **Claudin sends no `display`, so on all
  three models it already gets empty thinking.**
- "You're still charged for the full thinking tokens. Omitting reduces
  latency, not cost." Sending `"omitted"` saves no tokens. The "running cost"
  that #237 attached to the missing `display` does not exist.
- `"updates"` returns reasoning blocks empty, as `"omitted"` does, while "the
  short progress updates some models write between tool calls come back as
  readable text". It needs `thinking-display-updates-2026-08-18`; without it
  the value is a 400. The models that write them are Fable 5.1, Mythos 5.1,
  Opus 5.5 and Fable 5. Each update is its own `thinking` block, right before
  the `tool_use` it introduces. The rendering rule: "any `thinking` block with
  non-empty text is a progress update, so render those and nothing else".
- "The `signature` field is identical whichever `display` value you set.
  Switching `display` values between turns in a conversation is supported."

## How Claude Code decides, from its bundle

Read from string literals in the 2.1.280 binary (`strings -n 8`; minification
mangles identifiers, not literals). Each item is verified in the code unless
it says otherwise, and each anchor is a literal to grep for.

- **The first-party-only set** (`Fg()`) is firstParty, anthropicAws,
  anthropicGoogleCloud or foundry, with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  unset and a non-HIPAA org. The real-endpoint check (`ms()`, above) gates
  thinking-binding, global scope and `"updates"` on top of it.
- **Model gates are catalog capabilities, not substrings.** Opus 5.5's entry
  lists `per_turn_effort`, `mid_conv_system`, `mid_conv_tool_change` and
  `default_effort:"medium"`. per-turn-control and mid-conversation-tool-changes
  follow those capabilities, which is why Sonnet 5 lacks both.
- **`display`.** Anchors: `function Yyr({explicitDisplay:e` and
  `case"connector_text":{if((yc?.type==="adaptive"`.
  - Interactive chooses `"summarized"` if `showThinkingSummaries` is set.
    Otherwise it upgrades to `"updates"` on a real first-party endpoint,
    unless `CLAUDE_CODE_THINKING_DISPLAY_UPDATES` is false; the beta is added
    and redact-thinking removed.
  - `-p` with text output chooses `"omitted"`.
  - A 400 on `thinking.display` drops the beta for the conversation and
    retries (`"retry:thinking-display-updates"`).
  - Progress updates are told apart by decoding the signature (protobuf field
    2→1→8, value `"narration"`); the docs' rule — non-empty text under
    `"updates"` — is equivalent.
- **thinking-token-count** needs interleaved thinking on first-party (or
  Bedrock / Mantle for new models) and nothing else — no interactive
  condition. The response's `thinking_delta.estimated_tokens` feeds the
  spinner (`g?.({type:"thinking_progress",estimatedTokensDelta:`).
- **context_management.** The only edit type anywhere in the bundle is
  `clear_thinking_20251015` with `keep:"all"`, sent whenever thinking is on and
  the beta is in the list. The docs say `keep:"all"` is the no-clearing default,
  so for Claude Code this is thinking management handed to the server, not
  clearing.
- **cache-diagnosis.** `diagnostics.previous_message_id` is the `message.id`
  of the previous real assistant response (`null` on the first turn), for
  main-thread, agent and SDK queries. The response carries
  `diagnostics.cache_miss_reason`, an object `{type, cache_missed_input_tokens}`.
  Its `type` is one of `model_changed`, `system_changed`, `tools_changed`,
  `messages_changed`, `previous_message_not_found` or `unavailable`. Claude
  Code only logs it. A 400 naming `diagnostics.previous_message_id` is retried
  without it.
- **thinking-binding-controls.** The header goes out on every real
  first-party request. `thinking.block_binding` is only added under GrowthBook
  `tengu_polished_dewdrop` or env `CLAUDE_CODE_POLISHED_DEWDROP`. With the
  header alone the server reports dropped blocks in
  `message_start.message.input_transformations[]`, as
  `{type:"thinking_dropped", path, reason}`.
- **`safeguards`** (the dangerous-tool-use arbiter). It only runs in auto
  mode. On a real first-party endpoint it also needs GrowthBook
  `tengu_smooth_chipmunk`, default false, and not `tengu_iridescent_crystal`.
  Its `classifier_context` carries permission mode, rules and rule roots, cwd,
  home, trusted directories, git state and user identity.
- **afk-mode** is header-only and follows the auto-mode latch. What it changes
  server-side is unknown; a 400 naming it turns auto mode off for the session.
- **advisor-tool.** The header goes out whenever the advisor is enabled
  (GrowthBook `tengu_sage_compass2` or env), even with no tool attached. The
  tool is `{type:"advisor_20260301", name:"advisor", model}`.
- **Effort.** The default is the catalog's `default_effort`. A top-level
  `effortLevel` in user settings is honored only for a fixed legacy model set
  that does not include Opus 5.5. That is why `effortLevel: "high"` in
  `~/.claude/settings.json` still produced `medium`.
- **Rejection handling.** Nearly every beta above has its own 400 handler that
  drops it, remembers the rejection for the conversation and retries. No beta
  is stripped on a 5xx.

## What Claudin does about it (the 2026-09-22 round)

- **Adopted**, each behind its own predicate: first-party provider,
  `isFirstPartyAnthropicBaseUrl()`, a non-Anthropic `ANTHROPIC_BASE_URL`
  excluded, and its own `CLAUDIN_DISABLE_*` killswitch. The adopted set:
  - `display` — `"updates"` interactive, `"omitted"` headless, `"summarized"`
    under `showThinkingSummaries`
  - thinking-token-count
  - context-management with `keep:"all"`
  - prompt-caching-scope
  - cache-diagnosis
  - afk-mode
- **Deferred** to a round of their own, since they are one change —
  reminders, per-turn effort and tool changes as `role:"system"` messages:
  mid-conversation-system, per-turn-control, mid-conversation-tool-changes.
- **Rejected**: `safeguards`. See `.claudin/memory/team/decisions/`.
- **Left off**: advisor-tool, which is a product decision.

## Reproduce

```
bun run scripts/bench/tokens/wire-matrix.ts capture        # both CLIs, 3 models, oauth + apikeyfull
bun run scripts/bench/tokens/wire-matrix.ts interactive    # both CLIs, 3 models, the TUI
bun run scripts/bench/tokens/wire-matrix.ts report --match=-oauth-
```

Captures land in `$TMPDIR/wire-matrix/`, one JSON per CLI × tag × auth ×
model. `claudindev` has to be a fresh `bun run build` of the tree under test.
