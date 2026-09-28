# Spec: the bundled prompt skills `/update-config`, `/batch`, `/debug`, `/loop`, and the registration list

## Purpose

Four skills that ship inside the CLI and whose whole job is to hand the model
a prompt, plus the startup list that registers every bundled skill:

| Module | What it is |
|---|---|
| `src/skills/bundled/updateConfig.ts` | `/update-config`: changing settings files, and building hooks that provably work |
| `src/skills/bundled/batch.ts` | `/batch`: planning a large mechanical change, then fanning it out to parallel worktree agents that each open a PR |
| `src/skills/bundled/debug.ts` | `/debug`: switching debug logging on and diagnosing a problem from the session's log |
| `src/skills/bundled/loop.ts` | `/loop`: repeating a prompt on a fixed interval or at a self-chosen pace, or running maintenance passes |
| `src/skills/bundled/index.ts` | `initBundledSkills()`: registers all eleven bundled skills at startup |

Each skill registers a definition with the bundled-skill registry
(`src/skills/bundledSkills.ts`, already rewritten, see
[bundledSkills.md](bundledSkills.md)). When the user types the command, or the
model calls the Skill tool, the registry calls the skill's
`getPromptForCommand(args, context)` and the returned text becomes the turn's
instructions.

Most of these modules is prose. The rewrite writes new prose with the same
intent. This spec therefore records what each prompt has to make the model do
and the facts it has to state, never the wording. The tests hold the prompts
to those facts.

## Public contract

These keep their names and signatures: modules outside this group call them.

| Export | Signature | Used by |
|---|---|---|
| `initBundledSkills` (`index.ts`) | `() => void` | `src/platform/main/action/setupAgent.ts`, once at startup (not under the `local-agent` entrypoint) |
| `registerUpdateConfigSkill` (`updateConfig.ts`) | `() => void` | `index.ts`, the skill-cost bench, tests |
| `registerBatchSkill` (`batch.ts`) | `() => void` | same |
| `registerDebugSkill` (`debug.ts`) | `() => void` | same |
| `registerLoopSkill` (`loop.ts`) | `() => void` | same |

- **The skill-cost bench** (`scripts/bench/tokens/measure-skill-invocation-cost.ts`) imports each of the four modules and calls the first export whose name starts with `register`. Each module therefore keeps exactly one such export. The bench then invokes every skill with empty arguments, which means its test turns debug logging on for the rest of a full `bun test` run.
- **`initBundledSkills`** also calls the register functions of seven skills outside this group (`code-review`, `simplify`, `verify`, `run`, `fewer-permission-prompts`, `create`, `refresh-rules`), by their current names.

Cross-module agreements the prompts take part in:

- **`/init` loads the hooks reference.** `src/commands/init.ts` tells the model to call the Skill tool with `skill: 'update-config'` and arguments that start with `[hooks-only]`, followed by a one-line summary of the hook being built. It relies on getting the hooks reference and the verification flow, and nothing else.
- **`/batch` workers run `/code-review` at `medium`.** `code-review` accepts `medium` as an effort level.
- **`/loop` schedules sentinels.** The bodies it asks the model to schedule for maintenance loops are the sentinel strings `AUTONOMOUS_LOOP_SENTINEL` and `AUTONOMOUS_LOOP_DYNAMIC_SENTINEL` from `src/agent/loopSentinels.ts`. That module expands them when the task fires, so the model must pass them exactly.

## Observable behaviour

### 0. Common to the four skills

- **One text block.** Every invocation returns exactly one `text` block, error messages included.
- **No context.** None of them reads the `ToolUseContext`. The tests pass an empty object.
- **No reference files.** None declares `files`, so none has a `skillRoot` or the base-directory announcement.
- **Registry defaults.** Everything the table below does not set stays unset: no aliases, no model or agent of its own, `context` unset (runs inline), no hooks.

| Skill | `argumentHint` | `allowedTools` | `disableModelInvocation` | `whenToUse` | `isEnabled` |
|---|---|---|---|---|---|
| `update-config` | none | `Read` | `false`: the model may invoke it | none | always enabled |
| `batch` | `<instruction>` | none | `true`: user only | set | always enabled |
| `debug` | `[issue description]` | `Read`, `Grep`, `Glob` | `true`: user only | none | always enabled |
| `loop` | `[interval] [prompt]` | none | `false` | set | `isKairosCronEnabled` from `src/tools/ScheduleCronTool/prompt.ts`, read at call time: false when `CLAUDIN_DISABLE_CRON` is truthy (`1`, `true`, `yes`, `on`) |

All four are `userInvocable: true`.

### 1. `/update-config`

**The description** is what the model routes on, since the skill is
model-invocable and has no `whenToUse`. It has to convey:
- the skill configures the harness through `settings.json` and `settings.local.json`;
- any behaviour the user wants to happen automatically on an event ("from now on", "whenever", "before" or "after" something) needs a hook, which the harness runs and the model does not, so remembering a preference cannot deliver it;
- it also covers permissions, environment variables, hook troubleshooting and any other edit of those files;
- a few example requests of each kind.

**Two modes, chosen by the arguments.**
- **Hooks-only.** The arguments start with the exact text `[hooks-only]`, at position 0.
  - The prompt is the hooks reference described below, and nothing else: no settings guidance and no schema.
  - The rest of the arguments, trimmed, is appended at the very end as the task. The prefix itself does not appear in the output.
  - An empty or blank rest appends nothing. The result is then identical to the prompt for `[hooks-only]` alone.
- **Full.** Any other arguments.
  - The prompt is the settings guidance, then the hooks reference (the same text as in hooks-only mode, verbatim and contiguous), then the settings schema.
  - Non-empty arguments are appended at the very end as the user's request, and change nothing else: the prompt with a request starts with the prompt without one.

**The settings schema** is computed at every invocation. It is
`SettingsSchema()` (`src/platform/settings/types.ts`) converted by zod's
`toJSONSchema` for the input side (`io: 'input'`), and embedded as one fenced
`json` block that parses to exactly that value. Generating it keeps the prompt
in step with the settings types. The output side differs from the input side,
so it would not do. The block is about 97 KB.

**The settings guidance** has to get the model to:
1. **Pick a hook when the request is event-driven.** It maps typical requests to events: a compaction request to `PreCompact`, "after writing files" to `PostToolUse` with a `Write|Edit` matcher, and "when running shell commands" to `PreToolUse` with a `Bash` matcher.
2. **Read the target file first, then merge.** New entries are merged into what is already there, arrays especially (permission lists, hook lists). It must never replace the whole file, or an existing array, with only the new entries.
3. **Ask when it is ambiguous**, with `AskUserQuestion`: which file, whether to add to an array or replace it, which of several possible values.
4. **Know the three files, their scope, and which one wins:**
   - `~/.claudin/settings.json`: the user's own, for every project;
   - `.claudin/settings.json`: the project's, committed and shared with the team;
   - `.claudin/settings.local.json`: personal overrides for one project, gitignored.

   Later sources override earlier ones in the order user, then project, then local.
5. **Have worked examples of the keys people ask for:**
   - permissions: `allow`, `deny`, `ask`, `defaultMode` and `additionalDirectories`, with the three rule forms: an exact command `Tool(command)`, a prefix `Tool(prefix:*)`, and a bare tool name;
   - `env`, `model`, `agent` and `alwaysThinkingEnabled`;
   - `attribution`, with `commit` and `pr`, where an empty string hides that attribution;
   - MCP: `enableAllProjectMcpServers`, `enabledMcpjsonServers` and `disabledMcpjsonServers`;
   - `enabledPlugins`, whose keys have the form `name@source`;
   - `language`, `cleanupPeriodDays` (its default, and that `0` turns transcript persistence off), `respectGitignore`, `spinnerTipsEnabled`, `spinnerVerbs`, `spinnerTipsOverride` and `syntaxHighlightingDisabled`.
6. **Follow a workflow.** Clarify, read, merge, write, then tell the user what changed. Short worked examples show it for a formatter hook, a permission and an environment variable.
7. **Avoid the usual mistakes:** replacing instead of merging, editing the wrong file, leaving invalid JSON, writing without reading.
8. **Troubleshoot a hook that does not run.** Check the file and its JSON, the matcher, and the hook type, then run the command by hand. Finally, run the CLI with `--debug` to see hook execution.

**The hooks reference** (in both modes) has to state:
1. **The shape of an entry.** `hooks`, then the event name, then a list of `{ matcher, hooks }`. Each hook has `type` and `command`, plus an optional `timeout` in seconds and an optional `statusMessage`.
2. **The events, what each matcher matches, and when each runs:**
   - `PreToolUse` (a tool name; it can block the call);
   - `PostToolUse` (after a successful call);
   - `PostToolUseFailure` (after a failed call);
   - `PermissionRequest` (before the permission prompt);
   - `Notification` (a notification type);
   - `Stop`;
   - `PreCompact` and `PostCompact` (matcher `manual` or `auto`; the second receives the summary);
   - `UserPromptSubmit`;
   - `SessionStart`.

   It also gives the common tool matchers: `Bash`, `Write`, `Edit`, `Read`, `Glob` and `Grep`. Every event named must be a member of `HOOK_EVENTS` (`src/platform/entrypoints/sdk/coreTypes.ts`); these ten are a subset of it.
3. **The three hook types.**
   - `command` runs a shell command.
   - `prompt` has a model judge a condition.
   - `agent` runs an agent with tools.

   Which events accept `prompt` and `agent` is stated as `src/platform/lifecycleHooks/` actually allows it (see finding 10).
4. **What a hook reads on stdin:** JSON with `session_id`, `tool_name` and `tool_input`, plus `tool_response` on `PostToolUse` only.
5. **What a hook may print as JSON:**
   - `systemMessage`, shown to the user;
   - `continue`, where `false` stops;
   - `stopReason`;
   - `suppressOutput`;
   - `decision`, where `block` applies to `PostToolUse`, `Stop` and `UserPromptSubmit` (it is deprecated for `PreToolUse`);
   - `reason`;
   - `hookSpecificOutput`, carrying `hookEventName` and `additionalContext`, plus `permissionDecision` (`allow`, `deny` or `ask`), `permissionDecisionReason` and `updatedInput`, all three for `PreToolUse` only.
6. **Common patterns:** formatting after writes, logging shell commands to a file under `~/.claudin/`, a `Stop` hook that shows a message (it prints JSON with `systemMessage`), and running the tests after edits.
7. **A verification flow for constructing a hook**, step by step:
   1. **Dedup.** Read the target file. If the same event and matcher already have a hook, show it and ask whether to keep it, replace it or add alongside.
   2. **Build the command for this project.**
      - Take payload fields out safely: `jq -r` into a quoted variable, or a `read -r f` block. Never an unquoted `xargs`, which splits on spaces.
      - Invoke the tool the way the project does.
      - Skip inputs the tool cannot handle.
      - Keep the command raw, with no error suppression, until it has been tested.
   3. **Pipe-test it.**
      - Synthesize the payload the hook will receive and `echo` it into the command: an edit payload naming a real file, a shell payload, or `{}` for the events that do not read stdin.
      - Check both the exit code and the side effect.
      - Only then wrap it with `2>/dev/null || true`, unless the user wants a blocking check.
   4. **Write it** by merging into the target. If that creates `.claudin/settings.local.json`, add the file to `.gitignore`, because the file tools do not.
   5. **Validate syntax and shape in one `jq -e` query** over `.hooks.<event>[]`, selecting the matcher and then the command. Exit 0 with the command printed means it is correct, 4 means the matcher does not match, and 5 means malformed JSON or wrong nesting. A malformed settings file silently disables every setting in it.
   6. **Prove it fires.** This applies only to `PreToolUse` and `PostToolUse` on a matcher the model can trigger in the same turn.
      - For a formatter, introduce a violation it corrects and check it was corrected. Trailing whitespace will not do, because the edit tool strips it.
      - For anything else, temporarily prefix the command with an append to a sentinel file under the temp dir, trigger the tool, and read the file.
      - Undo the violation or the prefix either way.
   7. **Explain a failed proof.** If the proof fails although the pipe-test and the `jq` check passed, the hook is correct. The settings watcher only watches directories that held a settings file when the session started, so the user has to open `/hooks` once, or restart. The model cannot do that itself.
   8. **Hand off.** Say the hook is live (or needs `/hooks` or a restart), and point at `/hooks` to review or disable it. A hook that succeeds is normally silent in the UI, so the user should not read silence as failure.

### 2. `/batch`

**Registration.**
- **Description.** It has to convey that the skill researches and plans first, then executes in parallel across 5–30 agents, each in an isolated worktree, and each opening a PR.
- **`whenToUse`.** It has to name sweeping mechanical changes across many files (migrations, refactors, bulk renames) that split into independent units that can run in parallel.

**Arguments and checks, in this order.**
1. **The instruction** is the arguments, trimmed. When it is empty, the whole prompt is a short usage message. The message asks for an instruction and shows a few example invocations, each on its own line and starting with `/batch ` followed by an instruction. This check comes before the repository check.
2. **The repository check.** When the session's working directory is not inside a git repository, the whole prompt is a short message. It says `/batch` needs a repository because its agents work in git worktrees and open PRs, and suggests initializing one or running from inside one. It has no usage examples and no orchestration.
   - The working directory is `getCwd()`, which honours a per-agent override. The check is `getIsGit()` from `src/vcs/git/git.ts`, or an uncached equivalent over `getCwd()`.
   - It is decided at call time. The suite resets `getIsGit`'s memo around each call, so the skill must keep no answer of its own between calls.
3. **Otherwise**, the orchestration prompt, carrying the trimmed instruction.

**The orchestration prompt** has to get the model to:
- **Phase 1, in plan mode.**
  - Enter plan mode now with `EnterPlanMode`.
  - Research the scope with foreground subagents, because it needs their results: the files, patterns and call sites involved, and the conventions to follow.
  - Split the work into 5–30 units. Each unit can be implemented alone in an isolated git worktree and merged on its own, and the units are roughly equal in size. The count scales with the change, and slicing by directory or module is preferred.
  - Settle an end-to-end check the workers can run unattended. Candidates are browser automation for UI changes, driving the CLI (for example in `tmux`) for CLI changes, a dev server plus `curl` for APIs, or an existing e2e or integration suite.
  - If no such check is found, ask the user with `AskUserQuestion`, offering two or three concrete options, because workers cannot ask the user themselves.
  - Write the plan: a research summary, the numbered units (title, files, a one-line change), the check (or why it is skipped), and the exact worker instructions.
  - Present the plan with `ExitPlanMode`.
- **Phase 2, after approval.**
  - Launch one background agent per unit with the `Agent` tool, every one with `isolation: "worktree"` and `run_in_background: true`, all in a single message so they run in parallel.
  - Give each agent a self-contained prompt: the overall goal, its unit as planned, the conventions found, the end-to-end check, and the worker instructions verbatim.
  - Use `subagent_type: "Code"` (`GENERAL_PURPOSE_AGENT.agentType`) unless a more specific agent type fits.
- **The worker instructions**, a template copied verbatim into each agent's prompt:
  1. Review its own change with the `Skill` tool (`skill: "code-review"`, `args: "medium"`), and fix every bug reported.
  2. Find and run the project's tests, and fix any failures.
  3. Run the end-to-end check, unless the plan skips it for this unit.
  4. Commit, push the branch and open a PR with `gh pr create`. If `gh` is missing or the push fails, say so.
  5. End with exactly one line, `PR: <url>`, or `PR: none — <reason>`.
- **Phase 3, tracking.**
  - Show a table with the columns `#`, `Unit`, `Status` and `PR`, with every unit `running`.
  - As each agent's completion arrives, read its `PR: <url>` line and redraw the table with `done` or `failed` and the link, keeping a short note on each failure.
  - At the end, show the final table and a one-line tally of units landed as PRs out of the total.

### 3. `/debug`

**Registration.** The description says the skill turns on debug logging for
this session and helps diagnose issues. It is user-only, which also keeps its
description out of the model's context.

**Side effect.** Every invocation calls `enableDebugLogging()` from
`src/shared/debug.ts`, so debug logging stays on for the rest of the process.
Its return value says whether logging was already on.

**Runtime inputs, all read at call time:**
- **The log path,** `getDebugLogPath()`. That is the `--debug-file` argument, else `CLAUDIN_DEBUG_LOGS_DIR` (which, despite its name, holds the file path), else `~/.claudin/debug/<session id>.txt`.
- **The tail of the log.**
  - No more than the last 64 KiB is read, because the log grows without bound and reading it whole would spike memory.
  - Of that window, the last 20 lines are embedded in a fenced block.
  - The log's size is shown as `formatFileSize` formats it (`src/shared/text/format.ts`), for example `1.5KB` or `195.3KB`.
- **The three settings files.** These are the absolute paths `getSettingsFilePathForSource` returns (`src/platform/settings/settings.ts`) for `userSettings`, `projectSettings` and `localSettings`.
- **Whether logging was already on.**

**The prompt** has to:
- **Frame the task:** helping the user debug a problem in the current session.
- **Announce the switch only when logging was off before this call.** It says nothing before this invocation was captured, and tells the model to:
  - let the user know logging is now on, naming the log path;
  - ask them to reproduce the problem;
  - re-read the log afterwards.

  It also mentions that restarting the CLI with `--debug` captures a session from its start. When logging was already on, none of this appears, and in particular no `--debug` advice.
- **Name the log path.**
- **Give the state of the log.**
  - **The log exists:** its size and its last 20 lines.
  - **It does not exist:** say so as the expected state right after logging was switched on, not as a failure, and with no error code.
  - **It cannot be read:** say the tail could not be read, including the error's message (for a directory, `EISDIR`).
- **Point at the whole file:** tell the model to search it for `[ERROR]` and `[WARN]` lines, stack traces and failure patterns.
- **Carry the issue.** The arguments are embedded as given. With no arguments, the model is asked to read the log and summarize its errors, warnings and anything notable.
- **List the settings files:** user, project and local, with their paths.
- **Suggest the guide agent,** `claudin-guide` (`CLAUDE_CODE_GUIDE_AGENT_TYPE` in `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`), for how the relevant features work.
- **Ask for a plain-language explanation**, followed by concrete fixes or next steps.

### 4. `/loop`

**Registration.**
- **Description.** It has to convey that a prompt runs on a fixed interval or reschedules itself, and that a bare call runs maintenance.
- **`whenToUse`.** It has to name polling for a status, babysitting a workflow, recurring maintenance, and re-running a prompt within the current session.

**The arguments, after trimming.**
- **An interval** is a positive whole number, leading zeros allowed, followed by a unit, in any letter case:
  - seconds: `s`, `sec`, `secs`, `second`, `seconds`;
  - minutes: `m`, `min`, `mins`, `minute`, `minutes`;
  - hours: `h`, `hr`, `hrs`, `hour`, `hours`;
  - days: `d`, `day`, `days`.

  It is normalized to the number and a one-letter unit: `2 Hours` becomes `2h`, `007m` becomes `7m`, and `5M` becomes `5m` (minutes). Zero, negative numbers, decimals, other units (`w`, `ms`) and trailing punctuation (`5m,`) are not intervals.
- **The five shapes:**

  | Arguments | Loop |
  |---|---|
  | empty | self-paced maintenance |
  | only an interval (a space before the unit is allowed here: `5 minutes`) | fixed maintenance at that interval |
  | an interval as the first whitespace-separated token, then a prompt | fixed, with that prompt |
  | a prompt ending in `every <number> <unit>` (the word `every` in any case, spaces allowed before the unit) | fixed, with the clause removed from the prompt |
  | anything else | self-paced, whose prompt is the whole trimmed argument, verbatim, inner spaces and newlines included |

- **An `every` clause whose unit is not a time unit** leaves the text as a prompt: `check every 5 PRs` is a self-paced loop with exactly that prompt.

**A fixed loop's prompt** has to:
- **State the requested interval** in its normalized form.
- **Give the scheduled body.**
  - **With a prompt:** the prompt, verbatim, alone between a line containing `BEGIN` and a line containing `END`. The same text runs now and at every fire. Neither sentinel appears, and neither does the maintenance prompt.
  - **For maintenance:** the body is `<<autonomous-loop>>` (`AUTONOMOUS_LOOP_SENTINEL`), alone between `BEGIN` and `END` lines, with a note that it must be passed exactly because it is expanded at delivery. For the run now, the prompt includes `MAINTENANCE_PROMPT` in full. The self-paced sentinel does not appear.
- **Explain the cron conversion.** The interval becomes a recurring cron expression over the units `s`, `m`, `h` and `d`. Cron works in minutes, so seconds round up to a minute. An interval that does not map to a clean cadence is replaced by the nearest clean one, and the user is told which.
- **Call `CronCreate`** with the cron expression, the scheduled body, `recurring: true` and `durable: false` (the task lives for this session only).
- **Confirm to the user:** what was scheduled, the cron expression, the cadence in words, that recurring tasks expire after `DEFAULT_MAX_AGE_DAYS` days (7), and that `CronDelete` with the returned job ID cancels sooner.
- **Run the prompt immediately,** without waiting for the first fire. A prompt that starts with a slash command goes through the `Skill` tool.

**A self-paced loop's prompt** has to:
- **Say the model paces the iterations** with `ScheduleWakeup`.
- **Give the effective prompt.**
  - **With a prompt:** the prompt, verbatim, between `BEGIN` and `END` lines. The body to reschedule is `/loop <prompt>`, also between `BEGIN` and `END` lines, so the next iteration comes back through `/loop` and stays self-paced. No sentinel appears.
  - **For maintenance:** the effective prompt is `.claudin/loop.md` if it exists, else `~/.claudin/loop.md`, else the built-in `MAINTENANCE_PROMPT` (included in full). The project file is named before the user's. The body to reschedule is `<<autonomous-loop-dynamic>>` (`AUTONOMOUS_LOOP_DYNAMIC_SENTINEL`), with a note to pass it exactly rather than inline the instructions. The fixed sentinel does not appear.
- **Run the effective prompt now,** with slash commands through `Skill`.
- **Schedule the next iteration.** As the last action of the turn, call `ScheduleWakeup` exactly once, with:
  - `delaySeconds`, chosen by the pacing guidance in that tool's own description (the runtime clamps it to `WAKEUP_MIN_DELAY_SECONDS`–`WAKEUP_MAX_DELAY_SECONDS`, 60–3600);
  - `reason`, one short sentence for the user;
  - `prompt`, the body above.
- **Keep one wakeup:** a new call replaces the pending one, and `CronCreate` is never used in this mode.
- **Prefer an event.** If the next iteration waits on something the `Monitor` tool can watch (a CI run, a deploy, an endpoint or file changing), and that tool is available, arm a persistent monitor as the main wake signal. Keep `ScheduleWakeup` only as a 1200–1800 s fallback heartbeat.
- **End the loop** when the task is complete, the model is blocked on the user, or the user asked to stop. It does not call `ScheduleWakeup`, and tells the user the loop ended and why. If a wakeup from an earlier turn is still pending, it calls `ScheduleWakeup` with `cancel: true`.

### 5. The registration list

- **The skills and their order.** `initBundledSkills()` registers, unconditionally and in this order:
  1. `update-config`
  2. `debug`
  3. `code-review`
  4. `batch`
  5. `simplify`
  6. `verify`
  7. `run`
  8. `fewer-permission-prompts`
  9. `create`
  10. `refresh-rules`
  11. `loop`
- **Why the order matters.** `src/commands/commands.ts` adds the bundled skills to the command list in registration order, so any listing built from that list inherits it.
- **`/loop` is registered even with cron disabled.** It is then hidden by its `isEnabled`, which is read at call time. Registering it unconditionally is also what keeps its module in the bundle.
- **A second call** registers every skill again. Startup calls it once. Not pinned.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `/update-config` with `[hooks-only]` after leading whitespace, or in another letter case | full mode, with the text appended as the request. Not pinned |
| `/update-config` with a blank request | old: full mode with an empty request section. Not pinned. Decision: fix (a blank request is no request) |
| `/batch` with blank arguments, inside or outside a repository | the usage message |
| `/debug` with no log file yet | the not-yet-existing note, and no error code |
| `/debug` when the log path is a directory | the read failure, with `EISDIR` |
| `/debug` with a log ending in a newline (the normal case) | old: the final empty segment counts as one of the 20 lines, so 19 real lines show. The suite accepts 19 or 20. Decision: fix, and show 20 real lines |
| `/debug` with a log shorter than 20 lines, or empty | every line; an empty log shows `0 bytes` and an empty block. Not pinned |
| `/debug` when the 64 KiB window holds fewer than 20 lines | its first line can be partial. Not pinned |
| `/debug` with blank arguments | embedded as they are, with no summary request. Not pinned |
| `/loop every 5m` | old: a self-paced loop whose prompt is `every 5m`, which then reschedules itself with that prompt indefinitely. Not pinned. Decision: fix, as a fixed maintenance loop at `5m` |
| `/loop 5m` followed by a prompt with runs of spaces or newlines | old: the prompt's whitespace collapses to single spaces, and a multi-line prompt becomes one line. Not pinned. Decision: fix, keeping the prompt as typed (trimmed) |
| `/loop 5 minutes check the deploy` | a self-paced loop with the whole text as its prompt. Pinned, for parity |
| `/loop 0m`, `5w`, `1.5h`, `-5m`, `5ms`, `5m,` | never a cron task. Old: a self-paced loop with the text as its prompt. Only "not a cron task" is pinned, so a usage message would also pass |
| `/loop 30s` | normalized to `30s`; the model is told to round up to a minute. Pinned |
| `/loop` with a number too large for an integer | old: normalized in exponent form (`1e+21m`). Not pinned. Track |
| `CLAUDIN_DISABLE_CRON=1` | `/loop` is registered, and `isEnabled()` is false |

## Tests that pin it

- **`src/skills/bundled/inheritedSkills.characterization.test.ts`.** 75 tests. Line coverage of the old modules is 100% for `updateConfig.ts`, `batch.ts`, `debug.ts` and `index.ts`, and 96.6% for `loop.ts`, whose uncovered lines are a branch no input reaches. It controls the runtime inputs as follows, which the rewrite has to respect:
  - **The repository check.** `/batch` runs under `runWithCwdOverride` (`src/shared/fs/cwd.ts`), in one temp directory holding a `.git` directory and one without. `getIsGit`'s memo is cleared before and after each call.
  - **The debug log.** It is pointed at a temp file through `CLAUDIN_DEBUG_LOGS_DIR`, so the skill must read `getDebugLogPath()` at every invocation.
  - **The debug switch.** Debug logging is process-wide and cannot be switched off. The suite reads `isDebugMode()` before the first `/debug` call, and checks the switch announcement only when logging was off. It is off when the suite runs alone, as break-probe runs it, and may be on in a full run.
  - **The schema** is compared, as parsed JSON, with `toJSONSchema(SettingsSchema(), { io: 'input' })`.
  - **Tool names** are compared with their exported constants, not with literals.
- **`scripts/migrations/probes/rewrite-bundledPromptSkills.json`.** 30 probes: 8 on `updateConfig.ts`, 6 on `batch.ts`, 6 on `debug.ts`, 8 on `loop.ts` and 2 on `index.ts`. Every `find` matches exactly once. The break-probe run is the confirmation.
- **Removed with the rewrite**, because this project did not write them (openclaude did). The suite above covers everything they check.
  - **`loop.test.ts`:** the modes, the units, the `every` clause, the delimiters, the sentinels, the clamp, the Monitor fallback, and the ban on cron in self-paced mode.
  - **`updateConfig.test.ts`:** that the full prompt is generated, and embeds the schema.
- **`portedSkills.test.ts`** does not reach these five modules. It covers `simplify`, `verify`, `run`, `fewer-permission-prompts` and `refresh-rules`.
- **Not pinned, and why:**
  - **The wording, the section order and the prompt sizes.** The rewrite writes its own prose.
  - **The rows marked "Not pinned" above.**
  - **The Config-tool routing and the binary name in the restart and troubleshooting advice.** See the findings.
  - **Windows:** the unreadable-log case is skipped there.

## Out of scope

- **The other seven bundled skills** registered by `initBundledSkills`, which are separate modules.
- **Expanding the sentinels at delivery,** which is `src/agent/loopSentinels.ts`.
- **How the registry turns a definition into a command.** See [bundledSkills.md](bundledSkills.md).

## Findings

The old modules had each of these. None is fixed in the characterization: the
suite passes on the old code, and each one is left unpinned so that the
rewrite can apply the decision.

1. **A tool that does not exist.** The `/update-config` description and prompt send "simple" settings (`theme`, `editorMode`, `verbose`, `model`, `language`, `alwaysThinkingEnabled`, `permissions.defaultMode`) to a Config tool. This build has no such tool. `theme`, `editorMode` and `verbose` are not settings-file keys either: they live in the global config, where the user reaches them through `/config`. Decision: fix. Settings keys are edited in the settings files, and the user is pointed at `/config` for the others.
2. **Another product's binary.** `/debug` and `/update-config` tell the user to run `claude --debug`. This CLI is `claudin`. Decision: fix, taking the name from one place.
3. **Hard-coded paths in `/update-config`.** `~/.claudin/settings.json` is wrong when `CLAUDIN_CONFIG_DIR` is set, and in cowork mode (`cowork_settings.json`). `/debug` computes the real paths. Decision: keep the portable forms, which are pinned. Track adding the resolved user path next to them.
4. **Contradictory advice on a missing file.** The `/update-config` workflow says to ask the user to create a missing settings file, while its worked example and the hook flow create one. Decision: fix, allowing creation and keeping the `.gitignore` step for `settings.local.json`.
5. **`/loop every 5m`.** See the edge cases. Decision: fix.
6. **Whitespace in a fixed loop's prompt.** See the edge cases. Decision: fix.
7. **The 19-line tail.** See the edge cases. Decision: fix.
8. **Cost.** The full `/update-config` prompt is about 112 KB, 97 KB of it the schema, so every invocation spends tens of thousands of tokens. Track, as a later change outside a behaviour-preserving rewrite.
9. **Upstream names in the prose.** The `/batch` prompt names a browser skill this build does not ship, and the hooks reference refers to the model by another product's name. Decision: describe both generically.
10. **Hook types per event.** The old hooks reference says `prompt` and `agent` hooks work only on `PreToolUse`, `PostToolUse` and `PermissionRequest`. This build also runs `prompt` hooks on `Stop` (the `/goal` judge in `src/platform/lifecycleHooks/sessionHooks.ts`). Decision: check `src/platform/lifecycleHooks/` and state what it allows. Not pinned.

## Target design

- **One module per skill, plus the list.** Each skill module exports only its `register…Skill` function, which the bench relies on, and keeps its prose apart from its logic.
- **Shared prompt fragments**, each defined once:
  - **The hooks reference.** Both `/update-config` modes use the same fragment, and the suite checks that the full prompt contains the hooks-only prompt verbatim.
  - **The settings files.** One description of the three sources (label, scope, precedence), rendered in portable form by `/update-config` and with resolved paths by `/debug` through `getSettingsFilePathForSource`.
  - **A delimited block** for everything `/loop` hands over verbatim: the prompt, the scheduled body and the maintenance prompt.
  - **"Run it now"** (execute the effective prompt; slash commands through `Skill`), shared by both loop kinds.
  - **Tool and agent names** always come from their exported constants: `SKILL_TOOL_NAME`, `ASK_USER_QUESTION_TOOL_NAME`, `MONITOR_TOOL_NAME`, `GENERAL_PURPOSE_AGENT.agentType` and the rest. The old modules wrote several as literals. `MONITOR_TOOL_NAME` is now importable from `src/tools/MonitorTool/toolName.ts` without the tool's dependencies.
  - **The CLI's binary name** comes from one place.
- **Typed argument parsing, as pure functions.**
  - **`/loop`.** A parser from the argument text to a discriminated union of the two loop kinds. The fixed kind carries a typed interval (a count and a unit from `s`, `m`, `h` and `d`); both kinds carry an optional prompt. Units come from a table of spellings, not a chain of conditions, and the regexes live at module level. Rendering is separate, one pure function per kind.
  - **`/update-config`.** A parser that returns the mode and, when present, the task or the request.
  - **`/batch`.** A pure decision from the trimmed instruction and "in a repository" to one of the three outcomes.
- **Narrow dependencies with production defaults** (`code-design.md`), so the parts are testable without module mocks:
  - **`/batch`:** the repository check.
  - **`/debug`:** the logging switch, the log path, and a tail reader that takes a byte limit and a line count.

  The characterization suite still drives the defaults through the registry.
- **Errors.** A failed log read becomes part of the prompt (the fallback pattern) and is never thrown. A missing log is told apart with `isENOENT`. No `any`, and nothing is swallowed silently.
