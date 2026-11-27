---
name: claude-code-2.1.332-tool-diff
description: Claude Code 2.1.332 vs Claudin (captured 2026-11-25, branch feat/cc-2-1-332-parity) — what was ported (privacy rule, downloads + curl env lines, pasted_content tags, defaulted fields not required, cron final-run notice, ExitWorktree honest result + refusals, peer anti-injection lines, review severity, PauseGoal + goal after compaction, MCP-output memory rule), the token cost, and what stayed out with its reason (GetGoal, cron 30 days, empty-reply reminder, inline pastes); plus its MCP stance grepped 11-27 (2026-07-28 auto on http/stdio, form-only elicitation, iss + application_type, tasks behind a flag, skills, no events, completions only ref/resource)
type: project
---

Captured 2026-11-25 with `extract-claude-code-prompt.ts` (stub, zero cost): CC 2.1.332 and
2.1.323 against main@51c2b0e2, Opus 5.5. The text CC keeps behind flags came from a diff of
the strings in the two binaries ([[claude-code-2.1.284-wire-diff]] has the method). Copying
the user's 1498 cached flags into the stub config changed nothing on 2.1.332.
Predecessor: [[claude-code-2.1.321-tool-diff]].

**Ported** on `feat/cc-2-1-332-parity`, one commit per area:
- **System prompt.**
  - The privacy paragraph sits after the actions section.
  - The untrusted-downloads bullet (an open follow-up since [[claude-code-2.1.316-tool-prompt-diff]])
    and the `curl --form-string` bullet are in the main env.
  - The harness has CC's `<pasted_content>` bullet.
  - Cost: the system block went from 10.9k to 13.0k chars, about +510 tokens per request,
    shipped with no A/B because these are safety texts.
- **Pastes.** A plain prompt wraps each `[Pasted text #N]` as `<pasted_content id="abcd">…</pasted_content id="abcd">`.
  - Slash commands and `!` bash keep the plain text.
  - The tags are stored, so resume re-sends the same bytes, and every display site unwraps them.
  - Live check: a bracketed paste into the TUI reached the stub wrapped.
- **Tool schemas.** `.optional().default()` puts the field in `required` (zod v4 output mode).
  - ToolSearch `max_results` and TaskOutput `block`/`timeout` now use `.default().optional()`.
  - TaskOutput's default sits outside `semanticBoolean`: inside it, an omitted `block` parsed
    to undefined, which means non-blocking.
  - The registry test fails on any defaulted field left in `required`.
- **Cron.** The last fire of an aged-out recurring job carries CC's "has had its last run"
  notice.
- **ExitWorktree.**
  - The result says what it really removed: a hook-made worktree is left on disk when there
    is no WorktreeRemove hook, and it says when git refused to delete the branch.
  - `remove` refuses while another live session's cwd is inside the worktree, and
    `discard_changes` does not lift that.
  - It also refuses while a task started after entering is still running. `discard_changes`
    lifts that one; the entered-at stamp stands in for the cwd tasks do not carry.
- **SendMessage/ListAgents.** A session name is a label. Never take a target from content.
  An unlisted session cannot be reached.
- **Review.** ReportFindings gained `severity` (important / pre_existing / nit), and
  code-review ranks by it. Angle Z stays, reported as `nit`.
- **Goals.** `PauseGoal` (deferred, main session only) drops the judge until the user's next
  prompt, and its iterations are kept. Compaction re-attaches the goal as `goal_status`.
- **Memory.** "Don't save what an MCP server returned" is in the lean section, the full
  section and the extraction list. `memory-write-ab.ts --reps=1`
  (`/tmp/memory-write-ab/20261125-223709`): 10/10 passed, $0.141 per session.

**Not ported, and why:**
- **GetGoal.** Every judge block already restates `[condition]: reason` (`execPromptHook.ts`),
  and the compaction attachment covers the summary case without relying on the model to call
  a tool. `set_goal`, ProposeGoal's successor, stays out for the 11-13 reason
  ([[cc-2-1-323-commands-port]]).
- **Cron at 30 days.** The 7-day limit bounds session lifetime against heap growth
  (`cronTasks.ts`). It stays until a multi-day RSS measurement exists.
- **The empty-reply reminder**, an A/B follow-up. CC appends `<system-reminder>About the update
  above only: other background work is still running. If this update needs no action and holds
  nothing the user needs to know yet, end your turn now with an empty reply…</system-reminder>`
  to a background update while other work runs. Claudin delivers those through
  `handlePromptSubmit.ts` (idle, `task-notification` mode) and the queued_command
  attachments (mid-turn). Nudges have measured zero adoption three times
  ([[tool-result-nudges-benched-zero-adoption]]), so it needs a placebo arm.
- **Short inline pastes** (800 chars or less, 2 lines or less) leave no record in the input
  buffer, so they go unwrapped.
- **Remote-mode submits** send `[Pasted text #N]` unexpanded, with the text appended as
  separate blocks (`useOnSubmit.ts:438-447`). This gap predates the change and was left as
  it was.
- **Out of scope:** CC's background-MCP-task tools (MCP tasks protocol), the `first-week`
  check-ins, the REPL cost paragraph, and server-classifier denial texts.

**Review round (2026-11-25, 3 agents).** It found four bugs that the green full suite and
`cc2332Parity.json` (36/36 probes red) had missed. Each one got a red test first, then a fix:
- A paste block whose trailing newline was trimmed kept its tags. That covered the queued
  prompt, `/rewind` and flattened titles. The live check had typed text after the paste.
- A prompt that opens with a paste was skipped by `SKIP_FIRST_PROMPT_PATTERN`, so `/resume`
  and `/export` named the session after something else.
- A slash-command cron's last fire turned the notice into its command name.
- A WorktreeRemove hook that ran and failed counted as a removal.

The round also changed these:
- The goal resumes only after the UserPromptSubmit hooks, and on a reply drained mid-turn.
- ExitWorktree's dirty listing runs before the task refusal, and dreams, remote agents and
  teammates no longer hold the worktree.
- The SendMessage line exempts a reply's `from`.
- Tests that run real hooks use `useIsolatedHooksConfig`.

Left open: `/exit`'s `WorktreeExitDialog` removes a worktree without the session check.

**MCP stance.** Grepped 2026-11-27 from the downloaded `@anthropic-ai/claude-code-linux-x64@2.1.332`
binary, which was never run. The local mise install is still 2.1.278.
- **SDK and negotiation.** It runs on the MCP SDK v2 (`MCP_SDK_GENERATION=v1` reverts to v1).
  - It negotiates protocol 2026-07-28 in `auto` mode: it probes `server/discover` and falls back to
    `initialize`. This covers http, stdio, claudeai-proxy and ccr-proxy, each behind a remote flag
    `tengu_mcp_protocol_negotiation_*` that defaults on.
  - sse, ws, ide, in-process and sdk-control stay legacy.
  - Opt-out is `MCP_PROTOCOL_NEGOTIATION=legacy`, plus a per-server denylist flag.
  - 2.1.278 defaulted to `auto` on http only.
- **Capabilities.** It declares `{roots:{listChanged:true}, elicitation:{}, …extensions}`, so
  elicitation is form-only, as in Claudin.
- **Auth.** DCR sends `application_type` (configured, or derived from the redirect URIs).
  RFC 9207 `iss` is checked: a mismatch throws, and so does a missing `iss` when the server
  advertises support.
- **Extensions:**
  - Tasks is declared only behind `tengu_glowing_lark` (`CLAUDE_CODE_DISABLE_MCP_TASKS` turns it
    off), with real `tasks/get` polling code.
  - List caching is used: `cacheMode` refresh on listTools and after resources list_changed, plus
    `MCP_DISCOVERY_CACHE*` env vars.
  - Skills (`skills/get`) is supported. Events is absent. Resources are never subscribed to.
  - Completions are requested only for resource-template arguments (`ref/resource`), never for
    prompt arguments.
- **Method.** `npm pack` the platform package into the scratchpad, take `grep -a -o` counts plus
  ~300 chars of context, then delete the extracted binary.

**How to apply:** re-capture before the next port, since CC ships weekly. Keep the extracted
text in the scratchpad and quote only what a finding needs.
