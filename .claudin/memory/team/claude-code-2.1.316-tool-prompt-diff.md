---
name: claude-code-2.1.316-tool-prompt-diff
description: Claude Code 2.1.316 vs Claudin tool prompts on the wire (2026-11-01) — adopted on fix/tool-texts-match-tools (Monitor streaming + timeout_ms, TaskStop by name, five stale texts, AskUserQuestion/@name/Bash-description lines, cron next run); the untrusted-downloads bullet and three A/B-only levers stay follow-ups
type: project
---

Captured 2026-11-01 with `scripts/bench/tokens/extract-claude-code-prompt.ts` (CC 2.1.311 and
2.1.316 against a build of main@82a322dd, Opus 5.5, local stub, zero cost). Predecessor:
[[claude-code-2.1.284-wire-diff]], whose extraction recipe still works.

**Upstream since 2.1.284:** `<total_tokens>` is gone (2.1.316); the "Write code that reads like the
surrounding code" line is gone; the env message gained an untrusted-downloads bullet (own dir per
download, Python with `-I`); AskUserQuestion gained a "make each question stand on its own"
paragraph. Still 26 tools, env still in a `role: "system"` message.

**Adopted** (branch `fix/tool-texts-match-tools`, one PR, one commit per area):
- Monitor never streamed since the fork's first commit: `generateTaskAttachments` drops the bytes,
  and the `exec` timeout dies in `background()`. `monitorStream.ts` now polls ~1 s, caps an event at
  20 lines / 2 KB, stops a monitor after 20 events in 60 s, and owns `timeout_ms` (default 5 min,
  cap 30) like CC. Opt-in through `LocalShellSpawnInput.monitorStream`: ContainerTool also spawns
  with kind `'monitor'` (display only) and must not stream. Live-checked: five ticks, one
  notification each.
- TaskStop resolves `agentNameRegistry` names (live: `"sleeper"` stopped its agent).
- Stale texts fixed: Bash cwd (a sub-agent's cd resets every call), Workflow's omitted
  `run_in_background`, WebFetch's gh "via Bash", EnterWorktree refusing any worktree, the Agent
  `name` field.
- Ported in Claudin's own words: stand-alone AskUserQuestion questions (and its "This allows you
  to" list dropped), the GitHub `@name` warning in both git bodies, Bash `description` not
  repeating the command, cron results naming the real next run (local time, jitter included).
- The 3-agent review round found 5 bugs the green suite and two live runs missed, all fixed in the
  same PR: the stream counted decoded text, not bytes (a Latin-1 byte ate the next line's start;
  it reads raw bytes now), the event cap cut by characters, a failed read stopped the stream,
  `timeout_ms` refused `"60000"`, and a fired session cron job reported the next hour inside its
  jitter window (`firstFireMs`/`nextFireMs` in cronTasks.ts are now the one rule the scheduler
  and the tools share). Also changed: mid-turn task notifications read "A background task sent a
  notification" (was "A background agent completed a task", for Bash exits too), and the
  auto-mode classifier sees them as `Background task notification (not from the user)`, never as
  "User:".

**Follow-ups, decided out of that PR:**
- The untrusted-downloads env bullet — the user will revisit it.
- A/B with a placebo arm before adopting: Bash `run_in_background` "you'll be notified, don't
  poll" (the lean3 text says "Read its output file later"); EnterWorktree honoring CLAUDE.md or
  memory; CC's new intro line ("an agent working with the user toward their goals").
- WebFetch `offset` paging: only if a census shows the 100k cut biting.

**Why:** the user wants parity only where it is true of Claudin's tools; behavior levers go
through a bench ([[feedback-gates-need-a-placebo-arm]]).

**How to apply:** re-capture before any follow-up, since CC ships weekly; keep the extracted text
in a temp dir and quote only what a finding needs.
