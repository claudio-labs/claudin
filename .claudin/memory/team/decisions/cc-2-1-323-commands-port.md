---
name: cc-2-1-323-commands-port
description: The 2026-11-13 Claude Code 2.1.323 tools/commands analysis — /fork, /subtask, /autocompact and /recap built CC-like on feat/fork-autocompact-recap, the user's four choices (both fork names, no 150k gate, recap keeps the fast-model generator, per-model global window), the review round's fixes, and every candidate dropped with its reason
type: project
scope: commands, agent/fork, compact, away summary
impact: functional
---

**Decision:** From the CC 2.1.323 analysis on 2026-11-13, Claudin takes only the user-typed
commands that add no per-turn tokens: `/fork`, `/subtask`, `/autocompact` and `/recap`, modeled
on CC's behavior and wording, on branch `feat/fork-autocompact-recap`. The user validated it by
hand on 11-13, then a three-agent review round found the fixes listed below.

**The user's choices (one AskUserQuestion round):**
- **Both `/fork` and `/subtask`.** This went against the recommendation of `/fork` only. In CC
  the two never coexist: `/subtask` appears only when CC has fleet background sessions, and then
  `/fork` copies the whole session instead. Here both names call the same spawner
  (`forkFromDirective.ts`), each with CC's own wording.
- **No 150k gate on the typed fork,** as in CC. `forkGate.ts` still applies to the Agent tool only.
- **`/recap` keeps Claudin's generator**: the small fast model, the last 30 messages, no system
  prompt. It takes CC 2.1.323's prompt and 400-char cap, and the automatic away card changed with
  it. CC's generator is a cache fork on the main model with the full context, so on a provider
  with no prefix cache it would pay the whole context at main-model prices.
- **`/autocompact` per model and global, like CC.** It writes
  `modelSettings[<model>].autoCompactWindow` in the user's settings.json, which
  `getEffectiveContextWindowSize` reads just below `CLAUDIN_AUTO_COMPACT_WINDOW` (the env var
  wins). It is not project-scoped like `/model` and `/effort`. It keeps CC's 100k–1M range and
  parser, so a smaller model's window just caps it.

**The review round (11-13, after a green 18.5k suite and the live checks):** 12 red tests, then
the fixes. `/fork` handed the child the history before the last compaction and took the parent
prompt only from the slot the last main turn fills, so it refused a resumed conversation and,
after `/model`, ran the new model on the old prompt: it now uses a saved prompt only when it was
rendered for this model and this conversation, and rebuilds one otherwise, as CC does. Fork names
skip `main` and agentId shapes. `/autocompact` says when a project, local or policy window
overrides the user's, its dialog applies the off-grid window it shows and ignores a second
Enter, and it is `immediate`. The parse is strict (`150xyzk` was 150k). The recap cut counts
code points.
- **A deviation from CC the user did not pick:** `CLAUDIN_AUTO_COMPACT_WINDOW` read `200k` as 200
  tokens (parseInt, older than this branch). It now reads k/m suffixes, but keeps values below
  100k: CC clamps the env var to 100k–1M, and here a small local model needs a smaller window.
- Not taken: CC's "Started in the background" transcript line, a canonical model key (the
  runtime string keeps `[1m]`, which changes the window), and one launcher for the three
  background-agent spawns (fork, background skill, Agent tool), a follow-up.

**Rejected or dropped in the same analysis** (filtered against decisions/ first):
- `/context all`: in CC it only expands sections that fullscreen collapses, and Claudin's
  `/context` collapses nothing.
- WrapUp: one tool call every turn means tokens every turn. ProposeGoal, EndConversation and
  SendFile were not worth it either.
- Yield and SubagentHandback: Claudin's task notifications already cover them, together with
  [[only-main-owns-background-agents]].
- Focus view and the `/tui` restart: fullscreen-only, and the user runs inline.
- The explain-usage skill: `/context` and `/usage` already cover it.
- False positives from the binary scan: `/alias` is a bash completion spec, and `/pause-memory`
  ships with `isEnabled: false` in CC itself.
- Dropped as already decided: `/advisor`, `/keybindings`, LSP built-ins, `/brief` with the
  push/send tools, `/background` `/stop` `/daemon` `/peers`, `/version`, and everything tied to
  cloud or an Anthropic account.

**What changes for a teammate:**
- A later capture that shows CC's recap fork on the main model, or a typed fork without a size
  gate, is not a parity gap. Both were chosen above.
- Two coding gotchas from this branch live in the rules: command output is markdown, so
  `\<directive\>` (ink-tui.md §12), and `bun test` writes the real user settings.json
  (testing.md, the ambient-settings paragraph).
- `/autocompact auto` removes the model's entry, and `modelSettings` too when it ends up empty,
  so no `{}` is left behind (live check on 11-13).

**Evidence:** plan `.claudin/plans/deep-chasing-coral.md`. CC behavior was read from chunks
pulled out of the 2.1.323 binary (method in [[claude-code-2.1.284-wire-diff]]). Live check on
11-13: the fork's report reached main with cache reads, and at 200k `/context` showed an 833k
autocompact buffer. Re-checked live after the review fixes: `/autocompact 300k` applied during
a 40 s Bash call; the dialog over a saved 250k opened at 300k and Enter set 300k; `/fork main`
forked as `fork`; after `--continue`, `/fork` before any new turn ran on a rebuilt prompt and
reported back; a project-settings window was reported as an override; the env var read `200k`
as 200k. `ccCommandsPort.json` holds 30 break-probes, all red when broken. Predecessor:
[[cc-2-1-321-parity-limits]].
