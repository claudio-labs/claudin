---
name: claude-code-2.1.321-tool-diff
description: Claude Code 2.1.321 vs Claudin (captured 2026-11-09, shipped as #347 in v1.2.0 on 11-10) — what was ported (WebSearch date, CronCreate→Monitor, Monitor ws source + text, Agent effort input, directory-scoped and background skills), the review round's six bugs, real-wire facts the flagless stub capture misses; what stayed out is decisions/cc-2-1-321-parity-limits
type: project
---

Captured 2026-11-09: stub capture (`extract-claude-code-prompt.ts`, CC 2.1.321 vs main@e356d676,
Opus 5.5) plus a real-wire capture through `wire-proxy.ts` (CC interactive, Sonnet 5.5, the
user's OAuth and flags). Predecessor: [[claude-code-2.1.316-tool-prompt-diff]], whose three
A/B follow-ups (Bash "don't poll", EnterWorktree honoring CLAUDE.md, the new intro line) are
still open.

**Ported** (one commit each, merged as #347, released in v1.2.0 on 2026-11-10):
- WebSearch names no month; it points at the conversation's `Today's date` (the cached
  description had kept a stale month across a month boundary).
- CronCreate "Not for live watching → Monitor". The jitter is unchanged ([[cc-2-1-321-parity-limits]]).
- Monitor: the guidance rewritten in Claudin's terms, and a `ws: {url, protocols?}` source — a
  `ShellCommand` adapter (`src/tools/MonitorTool/webSocketCommand.ts`) that appends frames to
  the task output, so monitorStream, TaskStop and `timeout_ms` stay one path. SSRF uses the HTTP
  hooks' `isBlockedAddress` (loopback allowed) in `validateInput`, before the ask, and on Node the
  connection resolves through `ssrfGuardedNetLookup` (skipped behind a proxy, as for HTTP hooks);
  Bun's client has no lookup hook. A ws monitor gets a plain ask with no rule offered, so a mode
  that allows without asking (bypass, a tool-wide rule, auto) allows it — the user's call.
  Live-checked on Bun and Node against `wss://echo.websocket.org`.
- Agent `effort` input: replaces the definition's effort, ignored for a fork, persisted in the
  agent metadata for a resume.
- Skills: a nested `.claudin/skills` skill whose name is taken used to vanish (getCommands
  dropped it); it is now `apps/web:deploy` (`src/skills/scopedSkills.ts`), and calling the bare
  one lists its variants (`git status -z` dirs from the repo root, ≤100). Unlike CC, a bare name
  once offered stays with its skill for the session (the listing never re-announces a name).
  `background: true` on a `context: fork` skill runs it as a background agent when the Skill tool
  calls it — opt-in, where CC defaults it on; a typed `/skill` stays foreground in both.

**Review round (11-09, 3 agents):** six real bugs after a green 17.8k suite and live checks — a
`#fragment` hung the Node opener (ws throws in the load's `.then`), binary frames were sized after
UTF-8 decoding, `detach()` dropped the error listener ws still needs, git status paths are
repo-root relative, scoped names changed mid-session, a conditional skill and a nested one both
came out bare. Plus one Agreed Decision of the plan never built (the Node lookup pin). Each got a
red test commit, then its fix.

**Not ported:** per-turn effort (`per-turn-control`, a real ultrathink effort), the Agent "When
to use" paragraph, background-by-default forked skills, a stored rule for ws monitors, and CC's
50% / 30 min cron jitter. Each one's measurement or reason is in [[cc-2-1-321-parity-limits]].
mid-conversation-tool-changes was left too, unmeasured. Fable 5.2, already in CC's catalog at
this capture, shipped separately as #348 ([[claude-model-launch]]).

**Left open by the 11-09 review round (pre-existing, not this branch's):** the review's bug agent
reported that `isBlockedAddress` (`src/platform/lifecycleHooks/ssrfGuard.ts`, shared by HTTP
hooks and the ws source) lets NAT64 (`64:ff9b::/96`) and IPv4-compatible IPv6 addresses through;
not re-verified, not fixed.

**Real wire vs the stub (CC 2.1.321, Sonnet 5.5, OAuth):** CC moves the top-level effort to the
turn's AND adds `{role:"system", content:[], output_config:{effort}}` after the user turn;
ultrathink is `setTurnEffort("xhigh")` plus a system message with its reminder text; the env
system message carries `output_config` and the deferred tools as `tool_addition` blocks. Real
flags add system-prompt rules the flagless stub misses (`<pasted_content>`, treat the user's
details as private, `EndConversation`, WebSearch `mode`) and drop the "games" paragraph;
ScheduleWakeup on OAuth says 1-hour TTL, like Claudin's.

**Why:** parity only where it is true of Claudin's tools; behavior levers go through a placebo
A/B ([[feedback-gates-need-a-placebo-arm]] is the private rule behind it).

**How to apply:** re-capture both ways before a follow-up — the stub for byte-exact tool text,
the proxy for flags and per-turn wire. A CC TUI driven on a pty in a new cwd now opens its trust
dialog on "No, exit": send Down, then Enter. Live probes here run on the user's Max plan: read
`/usage` first (tmux, throwaway cwd) and size the run.
