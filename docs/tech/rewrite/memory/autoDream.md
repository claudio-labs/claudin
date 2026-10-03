# Spec: `memory/autoDream`, the background memory consolidation

## Purpose

Once in a while, at the end of a main-thread turn, a background agent goes over
the auto-memory directory and the recent sessions and turns what it finds into
durable, well-organized memories: it merges, corrects, prunes and re-indexes.
This is the "dream". The agent is a fork of the main conversation, so it reads
the parent's prompt cache, and it runs with the same tool policy as the memory
extraction: it may read, and it may write only memory files.

The unit decides when a dream is due, keeps two processes from dreaming at once
through a lock file, writes the prompt the fork gets, and reports the run as a
background task and, optionally, as a notice in the transcript. The manual
`/dream` command uses the same prompt and the same lock.

| Module | What it is |
|---|---|
| `src/memory/autoDream/autoDream.ts` | the trigger, the fork request, the task and the notice |
| `src/memory/autoDream/consolidationLock.ts` | the lock file, the last-consolidation time, the session scan |
| `src/memory/autoDream/consolidationPrompt.ts` | the dream prompt, private and team variants |
| `src/memory/autoDream/config.ts` | the on/off setting, kept apart so UI code can read it cheaply |

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `initAutoDream` | `() => void` | `src/platform/backgroundHousekeeping.ts`, once at startup, with no flag around it |
| `executeAutoDream` | `(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn) => Promise<void>` | `src/agent/query/stopHooks.ts`, fire-and-forget at the end of every main-thread turn, outside bare mode, when `toolUseContext.agentId` is unset; it passes `toolUseContext.appendSystemMessage` |
| `isAutoDreamEnabled` | `() => boolean` | `autoDream.ts`; `src/memory/ui/MemoryFileSelector.tsx`, for the initial state of its "Auto-dream: on/off" toggle, which writes `autoDreamEnabled` to the user settings |
| `buildConsolidationPrompt` | `(memoryRoot: string, transcriptDir: string, extra: string, teamRoot?: string \| null) => string` (`teamRoot` defaults to `null`) | `autoDream.ts`; `src/commands/dream/dream.ts` |
| `readLastConsolidatedAt` | `() => Promise<number>` | `autoDream.ts`; `dream.ts`; `MemoryFileSelector.tsx`, which shows "never" for `0` and "last ran …" otherwise |
| `tryAcquireConsolidationLock` | `() => Promise<number \| null>` | `autoDream.ts` |
| `rollbackConsolidationLock` | `(priorMtime: number) => Promise<void>` | `autoDream.ts`; `DreamTask.kill` in `src/agent/tasks/DreamTask/DreamTask.ts` |
| `listSessionsTouchedSince` | `(sinceMs: number) => Promise<string[]>` | `autoDream.ts`; `dream.ts` |
| `recordConsolidation` | `() => Promise<void>` | `dream.ts`, when it builds the manual prompt |

`REPLHookContext` is `src/platform/lifecycleHooks/postSamplingHooks.ts`;
`AppendSystemMessageFn` is the non-null type of
`ToolUseContext['appendSystemMessage']` (`src/tools/Tool.ts`).

Agreements with modules outside the unit:

- **The fork.** The unit asks `runForkedAgent` (`src/agent/coordinator/forkedAgent.ts`) for one fork per dream, and builds its cache parameters with `createCacheSafeParams` from the same module. `runForkedAgent` is the boundary the suite replaces.
- **The fork's tool policy** is `createAutoMemCanUseTool(getAutoMemPath())` from `src/memory/extract/extractMemories.ts` (the `memory/extract` spec, section 4).
- **The digest.** `collectDreamDigest(sinceMs, sessionIds)` from `src/memory/autoDream/dreamDigest.ts` (this project's own, with its own tests) gives the decision-sources text: plans changed, session prompts, impactful commits since a time. Its content belongs to that module.
- **The task.** `registerDreamTask`, `addDreamTurn`, `completeDreamTask`, `failDreamTask` and `isDreamTask` from `DreamTask.ts` hold the task's state; `DreamTask.kill` aborts a run from the background-tasks dialog and calls `rollbackConsolidationLock` itself.
- **The query source** `auto_dream` is declared in `src/agent/prompts/querySource.ts`. `src/providers/shims/claude/cacheControl.ts` keeps it off its short-lived list on purpose, so the fork keeps the main thread's 1-hour cache TTL.
- **The wire proxy.** `scripts/bench/ab/wire-proxy.ts` tells a fork request from the main loop by the first words of the fork's prompt (its `FORK_PROMPTS` list, matched with `startsWith` after trimming). The dream prompt must open with a phrase on that list. The rewrite may change the phrase, and must then change the list with it. The suite checks the pairing through `requestKind`.
- **The notice.** `src/agent/ui/messages/SystemTextMessage.tsx` renders the `memory_saved` system message. It does not read `verb` (finding 3).
- **The build flag.** `scripts/build/build.ts` ships `TEAMMEM` on. Under `bun test` every `feature()` reads false, so the team variant of a run is pinned by a child run with `--feature=TEAMMEM`.

## Observable behaviour

### 1. The setting: `isAutoDreamEnabled()`

- True only when the merged settings hold `autoDreamEnabled: true`. Unset or `false` is off, so the feature is off by default.
- Any settings layer counts, the repository's `.claudin/settings.json` included (finding 7).
- It is read at each call.

### 2. Whether an end of turn dreams: `executeAutoDream(context, appendSystemMessage?)`

The call always resolves, never rejects, and settles only when the dream it
started has ended. The outcomes, in the order a caller can tell them apart:

1. **Before `initAutoDream`** it does nothing. Pinned in a fresh process.
2. **Closed gates.** Nothing happens (no fork, no task, the lock untouched) when:
   - the setting is off (section 1);
   - auto memory is off, as `isAutoMemoryEnabled()` (`src/memory/memdir/paths.ts`) says: `CLAUDIN_DISABLE_AUTO_MEMORY` truthy, bare mode (`CLAUDIN_SIMPLE`), or `autoMemoryEnabled: false` in the settings;
   - assistant (KAIROS) mode is active (`getKairosActive()`);
   - remote mode (finding 1).

   Each is read at every call.
3. **The time gate.** The last consolidation is the lock's time (section 4). A dream is due when at least **24 hours** have passed since it; exactly 24 hours is due. With no lock on record the gate is open.
4. **The scan throttle.** When the time gate is open, the session directory is scanned at most once every **10 minutes** per `initAutoDream`. A turn within 10 minutes of the last scan does nothing; at exactly 10 minutes it scans again. A turn stopped by the time gate does not count as a scan. `initAutoDream` forgets the last scan.
5. **The session gate.** It needs at least **5** sessions, other than the current one, whose transcripts were touched strictly after the last consolidation (`listSessionsTouchedSince`, section 4). Sub-agent transcripts and files that are not `<session id>.jsonl` do not count. Fewer than 5: nothing happens, and the scan still counts for the throttle.
6. **The lock.** The unit then takes the lock (`tryAcquireConsolidationLock`). If the lock cannot be taken, because another live process holds it or because the memory directory cannot be created, nothing happens and nothing is thrown.
7. **Otherwise it dreams** (sections 3 to 5).

Overlap: while a dream runs, the lock carries the current time, so any further
turn, in this process or another, is stopped by the time gate.

### 3. What the fork is asked

Exactly one `runForkedAgent` request per dream:

- `promptMessages`: one user message whose content is the prompt, as a string.
- `cacheSafeParams`: the context's `systemPrompt`, `userContext`, `systemContext` and `toolUseContext` as they came, and `forkContextMessages` equal to the context's messages.
- `canUseTool`: the auto-memory policy for `getAutoMemPath()`. Read anywhere is allowed; `Write` inside the memory directory is allowed, outside it denied; read-only `Bash` is allowed and `rm` denied.
- `querySource` and `forkLabel`: both `'auto_dream'`.
- `skipTranscript: true`.
- `overrides`: exactly `{ abortController }`, a fresh `AbortController`, the same one the task holds.
- `onMessage`: a watcher (section 5).
- No `maxTurns`, no `maxOutputTokens`, and `skipCacheWrite` unset or false.

**The prompt** is `buildConsolidationPrompt(getAutoMemPath(), transcriptDir, extra, teamRoot)`:
- `transcriptDir` is `getProjectDir(getOriginalCwd())` from the session-storage barrel.
- `teamRoot` is `getTeamMemPath()` when the build has `TEAMMEM` and team memory is on (it follows auto memory), else `null`. In the shipped build every dream gets the team variant.
- `extra` is the run's own text, so it lands under the prompt's additional-context heading (section 6). It states, in this order:
  1. **Tool constraints.** In this run `Bash` is read-only. It names `` `ls` ``, `` `find` ``, `` `grep` ``, `` `cat` ``, `` `stat` ``, `` `wc` ``, `` `head` `` and `` `tail` `` (in backticks) as the kind allowed, and says that anything writing, redirecting to a file or changing state is denied, so the model need not probe.
  2. **The sessions.** Their count in parentheses, then one line `- <session id>` per session, the current session excluded.
  3. **The digest,** last: `collectDreamDigest(lastConsolidatedAt, sessionIds)` exactly, so its period starts at the last consolidation (the digest's heading shows that time).

  These constraints belong to the automatic run only: the manual `/dream` runs in the main loop with normal permissions and writes its own `extra`.

### 4. The lock: `consolidationLock.ts`

**The file.** `.consolidate-lock` inside the auto-memory directory
(`getAutoMemPath()`). It is shared by every process and every version working on
that memory, so its format is stored data:
- its **modification time** is the time of the last consolidation;
- its **body** is the decimal PID of the process consolidating, with no newline, or empty when no process holds it.

**`readLastConsolidatedAt()`** is the lock's modification time in milliseconds,
or `0` when there is no lock. The body does not matter. It never rejects.

**`tryAcquireConsolidationLock()`**
- **Backs off** (answers `null`, the file untouched) when the lock was touched less than **one hour** ago and its body, trimmed, starts with the PID of a live process. That includes this very process. A PID of 1 or less never counts as live.
- **Takes it** otherwise: no lock; a lock one hour old or more, even with a live holder (a guard against PID reuse); a dead holder; an empty or non-numeric body.
- **Taking it** creates the memory directory if needed, writes this process's PID as the body, and so stamps the current time. It answers the lock's previous time, or `0` when there was none: the value to roll back to.
- **Two processes reclaiming at once:** the one whose PID is in the file after both have written wins, and the other answers `null`. Not pinned (finding 6).
- It **rejects** when the memory directory cannot be created.

**`rollbackConsolidationLock(priorMtime)`**
- `0` removes the lock, so no consolidation is on record.
- Any other time empties the body and sets the modification time back to it. The emptied body frees the lock at once, even when that time is recent. If the lock was gone but the directory exists, an empty lock with that time is written.
- It never rejects: a failure (nothing to remove, no directory) is swallowed.

**`listSessionsTouchedSince(sinceMs)`**
- The ids of the session transcripts in `getProjectDir(getOriginalCwd())` whose modification time is strictly after `sinceMs`. It follows the original working directory, not the current one.
- Only `<uuid>.jsonl` files count: `agent-*.jsonl`, other `.jsonl` names and other extensions are ignored.
- The current session is included when its file qualifies; callers exclude it.
- The order is not specified. A missing directory gives `[]`.

**`recordConsolidation()`** stamps the lock now with this process's PID,
creating the memory directory. It does not check for a holder: it overwrites a
live one (finding 5). It never rejects.

### 5. The run

**While the fork runs:**
- The lock holds this PID and the time the run started.
- One task of type `'dream'` is registered: `status: 'running'`, `phase: 'starting'`, `sessionsReviewing` = the session count of section 3, `filesTouched: []`, `turns: []`, `priorMtime` = the lock's previous time (`0` if none), and the `abortController` of the request.
- **Where it lives.** It goes through `toolUseContext.setAppStateForTasks` when the context has one, else `setAppState`.

**The watcher (`onMessage`).** Each assistant message the fork produces adds one turn to the task:
- `text`: its text blocks, trimmed;
- `toolUseCount`: its tool-use blocks;
- **files touched.** The `file_path` of each `Edit` or `Write` call, when it is a string, is added to `filesTouched` once, in order of first appearance. The first one turns `phase` to `'updating'`.

Messages that are not from the assistant are ignored. A turn with no text, no
tool use and no new file is not recorded. (The task's own rules, such as keeping
only the latest turns, belong to `DreamTask.ts`.)

**Success.**
- **The task.** It becomes `'completed'`, `notified: true`, with an `endTime` and no `abortController`.
- **The lock** stays at the run's time with this PID, so the next dream is due in 24 hours.
- **The notice.** When `appendSystemMessage` was given, the task (read back through `toolUseContext.getAppState()`) touched at least one file, and `getGlobalConfig().notifyMemorySaved === true`, `appendSystemMessage` is called once with `{ type: 'system', subtype: 'memory_saved', writtenPaths, timestamp, uuid, isMeta: false, verb: 'Improved' }`:
  - `writtenPaths` is the task's `filesTouched`, `MEMORY.md` included;
  - `timestamp` is ISO and `uuid` is fresh.

  There is no notice otherwise, and none of those cases is an error. When the task was written to a store that `getAppState` does not read, there is no notice.
- **The token usage** of the answer is only logged.

**Failure** (the fork rejects, and the run was not aborted):
- the call still resolves;
- the task becomes `'failed'`, `notified: true`, without `abortController`;
- the lock is rolled back to its previous time, or removed when there was none, so the time gate is open again;
- the scan throttle is the back-off: the next turns within 10 minutes do not retry.

**Abort.** When the fork rejects after the request's `abortController` was
aborted, the unit leaves the task and the lock alone: whoever aborted owns them.
`DreamTask.kill` does exactly that: it marks the task `'killed'` and rolls the
lock back once.

### 6. The prompt: `buildConsolidationPrompt(memoryRoot, transcriptDir, extra, teamRoot = null)`

The rewrite writes its own prose. What follows is what the prompt must get the
model to do, and the facts it must state. `MEMORY.md` and 200 come from
`ENTRYPOINT_NAME` and `MAX_ENTRYPOINT_LINES` (`src/memory/memdir/memdir.ts`).

**Both variants:**
1. **Opening.** It opens with the wire proxy's marker (see the contract), and frames the task: a reflective pass that synthesizes recent learning into durable, well-organized memories, so future sessions orient quickly.
2. **Where things are.** The memory directory, `memoryRoot` in backticks, followed by `DIR_EXISTS_GUIDANCE` verbatim. The transcripts, `transcriptDir` in backticks, described as large JSONL files to grep narrowly and never read whole.
3. **Four phases, in order: orient, gather, consolidate, prune and index.** Each is marked `Phase 1` to `Phase 4` with its name.
   - **Orient:** list the memory directory, read the index (`` `MEMORY.md` ``), skim topic files to improve rather than duplicate, and review recent entries under `logs/` or `sessions/` when they exist.
   - **Gather,** sources in priority order:
     1. the decision sources in the digest under "Additional context": plans with their `## Context`, `## Agreed Decisions` and blast radius, session prompts, and impactful commits (`feat`, `refactor`, breaking); read a plan in full only when its entry suggests a decision that clears the bar;
     2. daily logs at `logs/YYYY/MM/YYYY-MM-DD.md`;
     3. memories that drifted from the codebase;
     4. a narrow transcript search, shown as a `grep -rn "<term>" <transcriptDir>/ --include="*.jsonl" | tail -50` command.

     Transcripts are never read exhaustively.
   - **Consolidate:** where to write (below); follow the memory format and types of the system prompt's auto-memory section; merge into existing files, convert relative dates to absolute ones, delete contradicted facts.
   - **Prune and index:** keep the index under 200 lines and ~25KB, each entry one line under ~150 characters in the form `` `- [Title](file.md) — one-line hook` ``, never memory content; remove stale pointers, shorten lines over ~200 chars, add new pointers, resolve contradictions.
4. **Close.** It asks for a brief summary of what was consolidated, updated or pruned, or a statement that nothing changed.
5. **Additional context.** A non-empty `extra` is appended last, exactly: a blank line, `## Additional context`, a blank line, then `extra`. An empty `extra` adds nothing.

**Private only (`teamRoot` null):**
- every memory goes at the top level of the memory directory;
- nothing about a team, team categories or git.

**With a team directory:**
- **The team root.** It is shown without its trailing separators (`/` or `\`, any number), so no path renders as `…team//…`.
- **Where to write:** private facts at the top level of `memoryRoot`; team decisions, known defects and documentation pointers in the matching category subdirectory of the team directory, with the index line under its section of `` `<team>/MEMORY.md` ``. The sections are named as `` `## Decisions` / `## Bugs` / `## Docs` ``, from `TEAM_CATEGORIES`. The link carries the subdirectory, shown as `` `(decisions/file.md)` ``; other team-scoped context goes at the team root.
- **Shared through git.** The team directory is git-tracked: what is written there shows in the user's `git status` and reaches teammates, the commit being the review. So only what clears the bar, and never a secret.
- **The categories.** `renderTeamCategoriesXml()` is quoted verbatim.
- **Orient** reads both indexes, and **prune** applies to each index touched.
- **The close** also asks to name every team file created, so the user knows what to review before committing.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `executeAutoDream` before `initAutoDream` | resolves, nothing happens. Pinned, in a fresh process |
| a sub-agent's turn, bare mode | the stop hook does not call the unit (outside the unit) |
| no lock on record | due as soon as 5 sessions qualify; `priorMtime` 0. Pinned |
| a session touched exactly at the last consolidation | does not count. Pinned |
| the current session's transcript | never counts. Pinned |
| too few sessions, then more arrive | nothing until 10 minutes after the scan. Pinned |
| the memory directory cannot be created | no dream, no task, no error. Pinned |
| a second turn while a dream runs | nothing: the lock time stops it. Pinned |
| the fork rejects | task failed, lock rolled back, the call resolves, no retry for 10 minutes. Pinned |
| the dream is killed from the task list | task killed, lock rolled back once, the call resolves. Pinned |
| aborted by someone else, then the fork rejects | the task stays `'running'` and the lock stays held. Pinned |
| the fork never answers | the call never settles; it is fire-and-forget at its caller. Not pinned |
| a live holder of a recent lock | `tryAcquireConsolidationLock` answers `null`. Through `executeAutoDream` only a cross-process race reaches this, since a recent lock already closes the time gate |
| two processes reclaiming at once | finding 6. Not pinned |
| a fork writes outside the memory directory | denied by the policy, still listed in the notice. Finding 2, not pinned |
| two text blocks in one assistant message | joined with nothing between them. Finding 4, not pinned |

## Security requirements

- **The fork writes only memory.** The tool policy is the extraction's (`memory/extract` spec, section 4 and its security requirements): `Edit` and `Write` only inside the auto-memory directory, `Bash` only read-only, every other writing tool denied. Pinned here through the request the unit sends.
- **Reads are open.** The fork reads anywhere, unattended, and greps the session transcripts outside the memory directory by design. See `memory/extract` finding 6.
- **No transcript.** The fork runs with `skipTranscript`.
- **Team memory stays free of secrets.** The team variant forbids them, and the write tools' team-memory secret guard (`checkTeamMemSecrets`, outside the unit) enforces it.
- **The lock never trusts a PID for more than an hour,** so a reused PID cannot block dreams for good.
- **A repository can switch the dream on** (finding 7).

## Tests that pin it

The suite, in `src/memory/autoDream/`:

| File | Tests | Pins |
|---|---|---|
| `autoDream.characterization.test.ts` | 29 | sections 1, 2, 3 and 5 with the build flags off: gates and their boundaries, the throttle, the request, the prompt's run-specific part, the task, the watcher, the notice, failure, kill and abort |
| `consolidationLock.characterization.test.ts` | 20 | section 4: the file, its body and time, acquiring, rolling back, recording, the session scan |
| `consolidationPrompt.characterization.test.ts` | 24 | section 6: the facts of both variants, verbatim sections, the additional context, the team root, the wire-proxy pairing |
| `autoDream.shipped.characterization.test.ts` | 1 (2 in its child) | a fresh process with `TEAMMEM` on: nothing before `initAutoDream`, then the team variant of the prompt |

- **The shared harness** is `src/memory/extract/__testutils__/extractionHarness.ts`. It gives each test a scratch directory holding `CLAUDIN_CONFIG_DIR`, `HOME` and the project, clears the memory switches, resets the settings, and replaces `runForkedAgent` with a double that records each request and answers from a script. A script that needs to see the run in progress (the lock, the task) looks from inside. The suite adds an app-state store per test, real session files with set modification times, and a frozen clock (`setSystemTime`) for the 24-hour, 1-hour and 10-minute boundaries. "Another live process" is a real child process. The digest runs `git log`, so git is isolated from the user's configuration.
- **The child run.** `autoDream.shipped` re-runs itself in a child `bun test --feature=TEAMMEM`, because the plain runner folds the flag to false and "never initialized" exists once per process. A failing child fails the parent test with the child's output.
- **Fixtures,** under `__fixtures__/rewrite/`:
  - `transcripts/` is a session directory: three session transcripts, a sub-agent transcript, a `.jsonl` that is no session id, and a `.txt`;
  - `locks/` holds lock bodies a reclaimer meets: `empty` (a rolled-back lock), `garbled` (not a number) and `init-pid` (PID 1).
- **Coverage,** with `bun test <suite> --coverage`, lines:
  - `autoDream.ts` 95.0%. The 8 lines left cannot be reached through the exports;
  - `consolidationLock.ts` 98.7%;
  - `consolidationPrompt.ts` and `config.ts` 100%.
- **The probe spec** is `scripts/migrations/probes/rewrite-memory-autoDream.json`: 40 probes, 24 on `autoDream.ts`, 10 on `consolidationLock.ts`, 5 on `consolidationPrompt.ts` and 1 on `config.ts`. Each turns at least one test red; the team-root and before-init probes go red through the child run.
- **Existing tests.** `consolidationPrompt.test.ts`, beside the unit, checks a subset of section 6 with phrase matches; 12 of its 43 lines are inherited from openclaude. Everything it checks is also in the suite, so it can go.

**Outside the suite, what pins the prompt text:**
- `src/memory/autoDream/consolidationPrompt.test.ts` matches phrases of the old wording byte for byte: the private top-level rule, `git-tracked`, the commit-is-the-review phrase, the naming of team files, the bold labels of the first two Gather sources, and `## Team categories`. Delete it or rewrite it with the prose.
- `scripts/bench/ab/wire-proxy.ts`: `FORK_PROMPTS` holds the prompt's opening byte for byte. Change it with the opening. `wire-proxy.test.ts` has no dream fixture.
- `src/agent/tools/__fixtures__/grepSamples/dup-heavy.txt` is a recorded grep output that holds a few lines of the old `autoDream.ts` source (imports, a tool-name check). It tests grep rendering, not this unit, and needs no change.
- No snapshot holds the prompt. The `registry` snapshot in `src/commands/__tests__/` only lists the `dream` command name.

**Not pinned, and why:**
- **The wording and order of the prompt's prose.** The rewrite writes its own.
- **Remote mode.** Nothing can set it (finding 1).
- **The two-reclaimer race** (finding 6): it needs two processes interleaving between a write and a read.
- **The debug log lines.**
- **The rows marked "Not pinned"** in the edge cases. Those are findings whose decision is "fix".

## Out of scope

- **The fork itself** (`runForkedAgent`, `createCacheSafeParams`): `src/agent/coordinator/forkedAgent.ts`.
- **The tool policy:** `createAutoMemCanUseTool`, in the `memory/extract` unit.
- **The digest:** `src/memory/autoDream/dreamDigest.ts`, this project's own, with its own tests.
- **The task's state and its UI:** `src/agent/tasks/DreamTask/DreamTask.ts`, the background-tasks dialog, the memory selector's toggle.
- **The manual command:** `src/commands/dream/dream.ts`, its own `extra`, and its choice to record the lock when the prompt is built.
- **The memory directory and its switches:** `getAutoMemPath`, `isAutoMemoryEnabled`, `getTeamMemPath`, `isTeamMemoryEnabled` (`memory/memdir`).
- **The shared prompt pieces:** `DIR_EXISTS_GUIDANCE`, `TEAM_CATEGORIES`, `renderTeamCategoriesXml` (`memory/memdir`).

## Findings

Each is left unpinned when its decision is "fix", so the rewrite can apply it.

1. **The remote-mode gate reads a flag nothing sets.** Its setter left with the `--remote` TUI path, so the gate is always open. Decision: fix, by dropping the gate. Nothing observable changes. (Same as `memory/extract` finding 7.)
2. **The notice lists attempts, not saves.** `filesTouched`, and so the notice, holds every path the fork named in an `Edit` or `Write` call, including calls the policy denied (outside the memory directory) or that failed. Decision: fix. List only paths inside the auto-memory directory whose call did not come back as an error. Nothing stored or configured depends on it, and the extraction takes the same fix (`memory/extract` finding 1). `MEMORY.md` stays listed: re-indexing is part of a dream.
3. **The notice's `verb` is never shown.** The unit sends `verb: 'Improved'`, outside the message type, and the renderer always says "Saved". Decision: keep for parity. The field stays, pinned, until the renderer reads it; track it there.
4. **Text blocks run together.** The text blocks of one assistant message are joined with nothing between them, so "Done.Next" shows in the task. Decision: fix, join with a newline. It is only shown in the task dialog.
5. **A manual `/dream` and an automatic one can clobber each other.** `recordConsolidation` overwrites a lock a live dream holds, and a failing or killed dream then rolls the time back, erasing the manual record. Decision: keep for parity. The order of the manual command's steps belongs to `dream.ts`, and the cost is one extra dream. Pinned (the overwrite).
6. **The reclaim race is a write-then-read check.** Two processes that reclaim a lock at the same moment can both read their own PID back, if one reads before the other writes, and both dream. Decision: fix, with an atomic creation (exclusive create, or write-then-rename) that keeps the on-disk format: the time is the last consolidation, the body a PID. The cost today is one duplicate dream, and no stored data changes. Not pinned.
7. **Security: a repository can switch the dream on.** `autoDreamEnabled` is honoured from the project's `.claudin/settings.json`, so a cloned repository can start unattended forks that spend the user's tokens, read anything the user can, and write memory. Writes stay inside memory (the policy), and the fork never runs git. Compare `autoMemoryDirectory`, which project settings may not set. Decision: keep for parity, because a team that commits the setting would notice. Pinned. Track: honour it from user, local and policy settings only.
8. **The setting's description is wrong.** The settings schema (`src/platform/settings/types.ts`) says the setting "overrides the server-side default". There is no server-side default: the dream is off unless the setting is true. Decision: fix the description when the schema is next touched. Nothing reads it but the user.

Observations that are not defects:
- **A live holder may be this very process.** `tryAcquireConsolidationLock` backs off from its own PID on a recent lock. The automatic path cannot meet it, because a recent lock closes the time gate first.
- **A failing fork retries every 10 minutes.** The throttle is the only back-off, so a persistently failing model is asked again at that pace while turns keep ending.
- **The session gate undercounts.** It scans the transcripts of the original working directory only, so sessions in other worktrees of the project do not count. It is a skip gate, so this only delays a dream.
- **An abort by anyone but `DreamTask.kill`** would leave a `'running'` task and a held lock (for up to an hour). Nothing else holds the controller today.

## Target design

- **One slice, split by responsibility.** Callers see the same exports at the same paths.
  - **The schedule.** A pure decision from the gates' answers, the last consolidation time, the last scan time and the qualifying session count, to one of `closed`, `notDue`, `throttled`, `tooFewSessions(count)` or `due(sessionIds, lastAt)`. It is a discriminated union, tested directly. The thresholds (24 h, 10 min, 5 sessions) are named constants.
  - **The lock.** A small module over the file: read the time, try to take it (with an atomic creation, finding 6), roll back, record. Its dependencies are narrow and have production defaults (`.claudin/rules/code-design.md`): the memory directory, the clock, the liveness check. The lock's state is a discriminated union (`absent`, `free(at)`, `held(pid, at)`).
  - **The run.** One function that registers the task, builds the request, runs the fork, and settles to `completed`, `failed` or `abortedElsewhere`. It takes the fork runner, the digest and the task store as dependencies with production defaults.
  - **The watcher.** A pure function from one fork message to `{ text, toolUseCount, touchedPaths }`, with the fixes of findings 2 and 4. It is tested directly.
  - **The prompt.** Prose apart from logic, one builder for both variants, and facts from constants: `ENTRYPOINT_NAME`, `MAX_ENTRYPOINT_LINES`, the category sections, the limits. The run's `extra` is built by its own function.
- **Types.** Explicit types for the schedule decision, the lock state, the request the unit builds, and the notice payload with `verb` declared, instead of an ad-hoc widening.
- **Errors.** Nothing reaches the stop hook. Each absorbed failure leaves a debug line. No `any`.
