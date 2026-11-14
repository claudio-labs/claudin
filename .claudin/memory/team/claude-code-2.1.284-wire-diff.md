---
name: claude-code-2.1.284-wire-diff
description: Claude Code 2.1.284 vs Claudin on the wire (2026-09-29) — five differences, all decided by measurement on perf/prompt-parity-2284: total_tokens parked then moot (CC dropped it in 2.1.316), env-as-role:system no-go (0.1%), auto-mode text not adopted, AskUserQuestion stays deferred; the lean3 dedup promoted; divergences not to "fix"; the extraction recipe every later capture reuses, plus (11-13) how to read commands/skills/flag-gated tools out of the Bun binary's embedded chunks
type: project
---

Captured 2026-09-29 with `scripts/bench/tokens/extract-claude-code-prompt.ts` (local stub, zero
cost): Claude Code 2.1.284 against the `fix/prompt-parity-cc` build, interactive TUI,
`claude-opus-5-5`, same empty cwd. The bugs and stale texts it found were fixed on that branch.
Predecessor: [[claude-code-2.1.270-prompt-diff]] (prose from `strings`, no wire).

**Outcome, 2026-09-29** (branch `perf/prompt-parity-2284`, one PR). Nothing shipped on the text
diff alone:
- **1, `<total_tokens>` — PARKED, now moot.** CC ended its system prompt and first-turn system
  message with `<total_tokens>15000000 tokens left</total_tokens>`. In the binary this is the
  `@internal` setting `totalTokensReminder` (`off | infinite | fixed | countdown |
  padded-countdown`); 15M fits padded-countdown, a budget re-anchored on each user prompt. It was
  built as `CLAUDIN_TOTAL_TOKENS=1`. Session A/B `/tmp/session-cache-ab/20260929-231527` (N=5,
  Opus 5.5 medium): the line reached 76/76 requests, cost −4.4% against a placebo at −5.3%. The
  per-turn countdown was never measured, and not for cache reasons: a reminder appended once to
  a tool result never rewrites the prefix (cache.md). Moot since CC 2.1.316 dropped the line
  (re-capture 2026-11-01).
- **2, the environment as `role:"system"` after the prompt — NO-GO.** CC moves cwd, git,
  platform, model and cutoff, the deferred tools, agent types, skills and the date into a system
  message after the user's prompt (beta `mid-conversation-system-2026-04-07`). Its system prompt
  stays static, with one block cached at `scope:"global"`. The API takes this on Opus 5.5 and the
  model obeys it (`beta-acceptance-probe.ts`, arm `mid-conv-system*`). But the only gain is
  reusing another directory's cached prefix: `cross-project-cache-estimate.ts
  --since=2026-09-15` found 36 of 168 cold starts it would serve, 0.1% of main-thread spend,
  against a 5% bar set before measuring. It is part of the mid-conversation trio in
  [[claude-code-beta-gap-2026-09-22]].
- **3, auto-mode text — not adopted.** CC's whole auto-mode text is one Bash-first paragraph:
  read with cat/head/sed, edit with sed or heredocs instead of Read/Edit/Write. That is the
  opposite of Claudin's Bash description, and cat-as-read already lost (+6%,
  [[cat-read-and-batch-read-ab-2026-09-24]]). The user closed it.
- **4, AskUserQuestion eager — rejected.** CC sent 24 tools (no Glob, Grep or Task*) with
  AskUserQuestion eager; Claudin sent 43. `deferred-load-census.ts` over 144 interactive sessions
  (19,876 requests) found 26 round trips made only to load it (72 with Enter/ExitPlanMode).
  Carrying the schemas eagerly would cost +0.85M input-token units more than those trips (~0.1%
  of spend). It stays deferred.
- **Promoted from the same round:** an audit of the first request found rules stated 2–5 times;
  each got one home, and the memory section's write-time rules moved behind
  `memoryFormatGuard.ts` (#271). The `lean3` arm: cost −4.7% (placebo −5.3%), turns equal,
  25/25 sessions passing, first-turn context 17.7k → 15.8k separated, memory-write check 12/12.
  No killswitch is left.

**Divergences Claudin already chose.** Do not "fix" these to parity without reopening the
decision:
- Sub-agents run inline in Claudin. Every CC sub-agent runs in the background and forks only on
  `subagent_type: "fork"` ([[fork-subagent-by-default]]).
- The main-thread cache is 1h. CC on an API key used 5 min and no cache_control on the identity
  block (OAuth may differ).
- Claudin sends `block_binding: drop_block` on Opus 5.5 and CC does not
  ([[claude-code-beta-gap-2026-09-22]]).

**Why:** the user wants parity only where a measurement says it pays. Size already ties: ≈46k
characters the model reads on CC's first request, ≈47k on Claudin's ([[prompts-v2-2026-09]]).

**How to apply — the extraction recipe** (reused for 2.1.316 and 2.1.321). Re-capture before any
follow-up, since Claude Code ships weekly:
`TMPDIR=<scratch> bun scripts/bench/tokens/extract-claude-code-prompt.ts
--model=claude-opus-5-5 --out=<dir>`. For Claudin add `--bin=<checkout>/bin/claudin
--config=<dir>` with a config.json whose anthropic profile has a fake apiKey AND a `baseUrl`;
without one the profile is dropped and the TUI opens the provider wizard. Put that dir outside
`<tmpdir>/cc-extract`, which every run deletes. Both CLIs can be captured at once with a
separate `TMPDIR` each (done 2026-11-09 on CC 2.1.321, ~2 min). The work dir is
`<TMPDIR>/cc-extract/work`, so the Claudin config's `projects[…].hasTrustDialogAccepted` key
must name that same TMPDIR, and `customApiKeyResponses.approved` takes
`"for-local-extraction"` (the stub key's last 20 chars). To size what the model reads, count
only `request.json` tools without `defer_loading: true`; meta.json lists every tool sent. The
extracted text is Anthropic's, so keep it in a temp dir. Run the arms with
`scripts/bench/ab/session-cache-ab.ts --variant=…` ([[session-cache-ab-bench-2026-09-23]]).

**What the wire does not show, and where to get it** (2026-11-13, CC 2.1.323). The stub capture
holds only the tools sent with no flags (26 tools). Slash commands, bundled skills and flag-gated
tools have to come from the binary:
- The binary is at `~/.local/share/mise/installs/claude/<ver>/claude`, with several versions side
  by side, which suits a diff between versions.
- It is a Bun standalone build. Each embedded JS file starts with `\0// @bun` and runs to the next
  NUL byte, so split on that.
- Pretty-print a chunk with `new Bun.Transpiler({loader:'js'}).transformSync(src)`. Biome refuses
  these chunks.
- A command is an object literal, `{type:"local-jsx"|"local",name:"…",description:…,
  argumentHint:…,load:()=>import(chunk)}`, and its behavior is in the loaded chunk. A tool
  carries a `searchHint:"…"` next to `name:`. The bundled skill names are one array of string
  constants.
- Minified names repeat across chunks (there were two different `OOe`), so find a definition by
  a parameter only it has.
- The rollout state for the account is in `~/.claude.json` under `cachedGrowthBookFeatures`.
  For example, commit/pr as on-demand skills was off there on 11-13.

The CC behavior in [[cc-2-1-323-commands-port]] was read this way.
