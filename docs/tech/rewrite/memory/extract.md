# Spec: `memory/extract`, the background memory extraction and the session-memory helpers

## Purpose

At the end of a main-thread turn, a background agent reads what was said since
it last looked and saves whatever is worth keeping into the auto-memory
directory. That agent is a fork of the main conversation: same system prompt,
same tools, same message prefix, so it reads the parent's prompt cache. It runs
with a tool policy that lets it read but write only memory files. This unit
decides when the fork runs, what it is told, how it is fenced, and what is
reported afterwards.

The unit also carries the helpers of **session memory**: a per-session
`summary.md` that compaction and the away summary read. Nothing in this build
writes that file any more (see finding 8), but its location, its reader, its
template check and its per-section cap are still called.

| Module | What it is |
|---|---|
| `src/memory/extract/extractMemories.ts` | the trigger, the fork request, the result handling, the fork's permission policy |
| `src/memory/extract/prompts.ts` | the prompt the fork gets, in two variants, and the repeated-error hint |
| `src/memory/session/paths.ts` | where a session's memory file lives |
| `src/memory/session/sessionMemoryUtils.ts` | reading that file; the last-summarized message id |
| `src/memory/session/prompts.ts` | the default template, the "still just the template" check, the per-section cap |

## Public contract

These keep their names and signatures: modules outside the unit call them.

| Export | Signature | Used by |
|---|---|---|
| `initExtractMemories` | `() => void` | `src/platform/backgroundHousekeeping.ts`, at startup, behind the `EXTRACT_MEMORIES` build flag |
| `executeExtractMemories` | `(context: REPLHookContext, appendSystemMessage?: (msg: Exclude<SystemMessage, SystemLocalCommandMessage>) => void) => Promise<void>` | `src/agent/query/stopHooks.ts`, fire-and-forget at the end of every main-thread turn, behind `EXTRACT_MEMORIES`, no `agentId`, and `isExtractModeActive()`; it passes `toolUseContext.appendSystemMessage` |
| `drainPendingExtraction` | `(timeoutMs?: number) => Promise<void>` | `src/platform/headless/print/runHeadless.ts`, before shutdown, behind `EXTRACT_MEMORIES` and `isExtractModeActive()` |
| `createAutoMemCanUseTool` | `(memoryDir: string) => CanUseToolFn` | this unit's fork, and `src/memory/autoDream/autoDream.ts` for its consolidation fork; both pass `getAutoMemPath()` |
| `buildExtractAutoOnlyPrompt` | `(newMessageCount: number, existingMemories: string, extraHint?: string) => string` | `extractMemories.ts`; `src/memory/memdir/memoryPrompt.test.ts` |
| `buildExtractCombinedPrompt` | same as above | same |
| `buildLoopHint` | `(toolName: string, repeatCount: number) => string` | `extractMemories.ts` |
| `getSessionMemoryDir` | `() => string` | `src/permissions/filePermissions/internalPaths.ts` (the read carve-out) |
| `getSessionMemoryPath` | `() => string` | `sessionMemoryUtils.ts`; `src/agent/compact/sessionMemoryCompact.ts`, which names the file in its truncation note |
| `getSessionMemoryContent` | `() => Promise<string \| null>` | `sessionMemoryCompact.ts`, `src/agent/awaySummary.ts` |
| `getLastSummarizedMessageId` | `() => string \| undefined` | `sessionMemoryCompact.ts` |
| `setLastSummarizedMessageId` | `(messageId: string \| undefined) => void` | `src/agent/compact/autoCompact.ts`, `src/commands/compact/compact.ts`, always with `undefined` |
| `DEFAULT_SESSION_MEMORY_TEMPLATE` | `string` | nothing outside the module (listed in `knip-baseline.json`) |
| `isSessionMemoryEmpty` | `(content: string) => Promise<boolean>` | `sessionMemoryCompact.ts` |
| `truncateSessionMemoryForCompact` | `(content: string) => { truncatedContent: string; wasTruncated: boolean }` | `sessionMemoryCompact.ts` |

`REPLHookContext` is `src/platform/lifecycleHooks/postSamplingHooks.ts`,
`CanUseToolFn` is `src/permissions/useCanUseTool.tsx`, and the message types are
`src/shared/types/message.ts`.

Agreements with modules outside the unit:

- **The fork.** The unit asks `runForkedAgent` (`src/agent/coordinator/forkedAgent.ts`) for the fork, and nothing else of that module is its business. That call is the boundary the suite replaces.
- **The query source** `extract_memories` is declared in `src/agent/prompts/querySource.ts`. `src/providers/shims/claude/cacheControl.ts` keeps it off its short-lived list on purpose, so the fork keeps the main thread's 1-hour cache TTL.
- **The notice.** `src/agent/ui/messages/SystemTextMessage.tsx` renders the `memory_saved` message, and `teamMemSaved.ts` reads its `teamCount`, which the message type does not declare.
- **The wire proxy.** `scripts/bench/ab/wire-proxy.ts` tells a fork request from the main loop by the first words of the fork's prompt (its `FORK_PROMPTS` list, matched with `startsWith` after trimming). The extraction prompt has to open with a stable phrase that is on that list. The rewrite may change the phrase, and must then change the list and the fixture in `wire-proxy.test.ts` with it. The suite checks the pairing by running the real prompt through `requestKind`.
- **The session-memory location.** `detectSessionFileType` (`src/tools/FileReadTool/guards.ts`) and `isAutoManagedMemoryFile` (`src/memory/memdir/memoryFileDetection.ts`) recognize session memory by a `/session-memory/` segment and a `.md` ending under the config home. `internalPaths.ts` allows reads under `getSessionMemoryDir()` by a string-prefix check, which is why the trailing separator matters.
- **The build flags.** `scripts/build/build.ts` ships `TEAMMEM`, `EXTRACT_MEMORIES` and `LOOP_ERROR_MEMORY_TRIGGER` on. Under `bun test` every `feature()` reads false, so the behaviour those flags add is pinned by a child run with `--feature` (see "Tests that pin it").

## Observable behaviour

### 1. Whether an end of turn forks

Each `executeExtractMemories` call is one end of turn. The outcomes, in the
order a caller can tell them apart:

1. **Before `initExtractMemories`** the call resolves and does nothing. So does `drainPendingExtraction`.
2. **Gated calls** do nothing and do not count toward the cadence. A call is gated when:
   - `context.toolUseContext.agentId` is set (a sub-agent's turn);
   - `CLAUDIN_EXTRACT_MEMORIES` is defined falsy (`0`, `false`, `no` or `off`, any case, surrounding spaces ignored). Any other value, the empty string included, leaves it on;
   - auto memory is off, as `isAutoMemoryEnabled()` (`src/memory/memdir/paths.ts`) says: `CLAUDIN_DISABLE_AUTO_MEMORY` truthy, bare mode (`CLAUDIN_SIMPLE`), `autoMemoryEnabled: false` in settings, or remote without a memory directory. `CLAUDIN_DISABLE_AUTO_MEMORY=0` wins over bare mode.

   Every switch is read at each call.
3. **The main agent saved a memory.** If any assistant message after the mark (below) holds an `Edit` or `Write` call whose `file_path` lies in the auto-memory directory (`isAutoMemPath`), there is no fork. The mark moves to the last message of the context, and the call does not count toward the cadence. Before the first mark exists, every message is considered. A save that sits before the mark does not stop later forks. This check comes before the repeated-error trigger.
4. **The cadence.** Otherwise the call counts. The fork runs on the Nth counted call, where N is `getExtractionTurnInterval()`: 15 by default, `CLAUDIN_EXTRACT_MEMORIES_EVERY` to retune it, and read at each call. The count starts again at every fork, a failed one included. A count already past a lowered N forks on the next call.
5. **The repeated-error trigger** (shipped build only). If the messages after the last human turn hold a repeated-error loop, as `detectRepeatedErrorLoop` (`src/memory/extract/loopDetector.ts`) reports one, the fork runs at once whatever the cadence, and the prompt carries `buildLoopHint(toolName, repeatCount)`. A loop fires once per (loop, human turn) pair, remembered per `initExtractMemories`:
   - the same loop in the same human turn falls back to the cadence;
   - a new human turn with the same loop fires again;
   - a different, louder loop in the same turn fires.

   A loop fork also restarts the cadence. `CLAUDIN_LOOP_MEMORY_TRIGGER` defined falsy turns the trigger off.
6. **Overlap.** From the moment a fork is decided until it ends, a further eligible call starts nothing and returns at once. Only the latest such call is kept.
   - When the fork ends, whether it succeeded or failed, one trailing fork runs for the kept context and reports through the kept call's `appendSystemMessage`.
   - The trailing fork ignores the cadence and never carries a loop hint. It is still skipped when the main agent saved a memory.
   - A loop first seen by a trailing fork fires on the next call instead.
   - The call that started the first fork settles only after the trailing fork has finished.

### 2. What the fork is asked

Exactly one `runForkedAgent` request per fork:

- `promptMessages`: one user message whose content is the prompt, as a string.
- `cacheSafeParams`: the context's `systemPrompt`, `userContext`, `systemContext` and `toolUseContext` as they came, and `forkContextMessages` equal to the context's messages. Those five and nothing else. The model is whatever the parent's tool-use context carries. There is no override, so the fork shares the parent's cache.
- `canUseTool`: `createAutoMemCanUseTool(getAutoMemPath())` (section 4).
- `querySource` and `forkLabel`: both `'extract_memories'`.
- `skipTranscript: true`, so the fork's messages are not recorded as a sidechain transcript.
- `maxTurns: 5`.
- No `maxOutputTokens` (it would change the thinking budget and so the cache key), no `overrides`, no `onMessage`, and `skipCacheWrite` unset or false.

**The prompt.**
- **Which builder.** In the shipped build, team memory follows auto memory, so every fork gets `buildExtractCombinedPrompt`. Without `TEAMMEM` it gets `buildExtractAutoOnlyPrompt`.
- **The count.** The number of new user and assistant messages; system, progress and attachment messages do not count. They are counted after the mark, or all of them when there is no mark or the mark is no longer in the messages (after a compaction).
- **The manifest.** `formatMemoryManifest(await scanMemoryFiles(getAutoMemPath(), signal))` from `src/memory/memdir/memoryScan.ts`, read at each fork. It is empty when the directory is missing or has no memory files. Its format belongs to that module:
  - one line per `.md` file, `MEMORY.md` excluded, newest first;
  - each line reads `- [type] relative/path.md (ISO modification time): description`, where the `[type] ` tag and the `: description` are left out when the frontmatter lacks them.
- **The hint.** The loop hint when a loop fired, else none.

### 3. What is done with the answer

- **Success.** The mark moves to the last message of the context the fork was given.
- **Failure.** When the fork or the manifest scan throws, the error is logged and swallowed and the call resolves. Nothing is announced, and the mark stays where it was, so those messages are new again next time.
- **The notice.** When `getGlobalConfig().notifyMemorySaved === true`, and the fork saved at least one file that is not an index, `appendSystemMessage` is called once with `{ type: 'system', subtype: 'memory_saved', writtenPaths, timestamp, uuid, isMeta: false }`: the shape of `createMemorySavedMessage` (`src/agent/messages/`), with an ISO timestamp and a fresh uuid.
  - `writtenPaths` holds the `file_path` of every `Edit` or `Write` call in the fork's assistant messages, in the order they first appear, each once, and without any file named `MEMORY.md`, in whatever directory.
  - Calls of other tools, calls without a string `file_path`, and non-assistant messages are ignored.
  - In the shipped build the message also carries `teamCount`: how many of `writtenPaths` lie in the team directory (`<auto-memory>/team/`), which is `0` when there are none. It is never left out.
- **No notice** when the setting is off or unset (the default), when the fork only touched indexes or wrote nothing, or when there is no `appendSystemMessage`. None of these is an error.
- **Usage.** The token usage in the answer is only logged.

### 4. The fork's permission policy: `createAutoMemCanUseTool(memoryDir)`

An async function. Each decision is one of:
- an allow, which hands the input back unchanged: `{ behavior: 'allow', updatedInput: input }`;
- a denial, `{ behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }`, whose message and reason are the same text.

| Tool (by registered name) | Decision |
|---|---|
| `Read`, `Grep`, `Glob` | allowed, on any path |
| `Bash` | allowed when the Bash tool's own input schema accepts the input and the tool says the command is read-only (`isReadOnly`). Otherwise denied, with a message saying only read-only commands are permitted |
| `Edit`, `Write` | allowed when `file_path` is a string that, once `..` segments are resolved, lies inside the auto-memory directory. Otherwise denied |
| anything else (`NotebookEdit`, `Patch`, `WebFetch`, MCP tools, `Agent`, …) | denied, even when aimed at the memory directory |

Every denial other than the read-only one names the allowed tools (`Read`,
`Grep`, `Glob`, read-only `Bash`, `Edit`/`Write`) and the `memoryDir` argument.
See finding 4 for what that argument does and does not do.

Examples of what the Bash tool classifies today:
- allowed: `ls -la`, `cat notes.md`, `grep -rn TODO .`, `find . -name "*.md"`, `head`, `wc`;
- denied: `rm`, a redirection into a file, `touch`, `mv`, `find -delete`, `sed -i`, `curl`.

### 5. `drainPendingExtraction(timeoutMs = 60_000)`

- **Nothing in flight** (or before init): it resolves at once.
- **Otherwise** it resolves when every call still in flight has settled, or when the timeout passes, whichever comes first. The call that started a fork stays in flight through its trailing fork. It never rejects.
- **The timer** does not keep the process alive.

### 6. `initExtractMemories()`

Starts from nothing: no mark, a cadence count of zero, no kept call, no loop
cooldown. Calling it again forgets all of that.

### 7. The prompts

The rewrite writes its own prose. What follows is what each prompt must get the
model to do, and the facts it must state. Tool names always come from the
tools' exported name constants.

**`buildExtractAutoOnlyPrompt(newMessageCount, existingMemories, extraHint?)`**
1. **Role.** The model now acts as the memory-extraction agent over the conversation above it. The opening words are the wire proxy's marker (see the public contract).
2. **Scope.** It looks at the most recent `~N` messages, the count written with a tilde. It uses only their content, and spends no turns investigating or verifying it: no searching sources, no reading code, no git.
3. **Tools.** `Read`, `Grep` and `Glob`; `Bash` read-only (`ls`, `find`, `cat`, `stat`, `wc`, `head`, `tail` and the like); `Edit` and `Write` only inside the memory directory. `rm` is not permitted, and every other tool (MCP, `Agent`, a `Bash` that writes) is denied.
4. **Turn budget.** The budget is small, and `Edit` needs a prior `Read` of the same file. So the model reads everything it may update in one turn, in parallel, then writes in the next, and does not interleave the two.
5. **The bar.** Writing nothing is the right result when nothing meets the save criteria. It must not lower the bar, because noise costs tokens in every later session.
6. **The manifest.** When `existingMemories` is not empty, it appears verbatim, introduced as the existing memory files and followed by an instruction to update an existing file rather than create a duplicate. When it is empty, nothing about existing files appears.
7. **The hint.** A non-empty `extraHint` appears verbatim. An empty one is the same as none.
8. **Explicit requests.** A request to remember something is saved at once, as the type that fits best; a request to forget finds and removes the entry.
9. **The shared sections,** verbatim: `TYPES_SECTION_INDIVIDUAL` and `WHAT_NOT_TO_SAVE_SECTION` from `src/memory/memdir/memoryTypes.ts`. There is no team material.
10. **How to save,** in two steps:
    1. Each memory goes in its own file, with the frontmatter shown by `MEMORY_FRONTMATTER_EXAMPLE`, verbatim.
    2. A pointer to it goes in `MEMORY.md`. That file is an index, not a memory, and has no frontmatter. Each entry is one line under ~150 characters, in the form `` `- [Title](file.md) — one-line hook` ``, and no memory content goes into it.

    Also:
    - `MEMORY.md` is always loaded into the system prompt, and lines after 200 are truncated.
    - A memory whose frontmatter has `paths:` (the same syntax as a rule in `.claudin/rules/`, relative to the project root) is attached automatically the first time a Read touches a matching file.
    - Memories are organized by topic, fixed or removed when wrong, and never duplicated.

**`buildExtractCombinedPrompt(newMessageCount, existingMemories, extraHint?)`**
(the shipped one)
- **Without `TEAMMEM`** it returns exactly the auto-only prompt.
- **The opening.** With the flag on, it opens as the auto-only prompt does: the same role, count, tools, budget, bar, manifest and hint, up to the point where the two part.
- **The shared sections,** verbatim: `TYPES_SECTION_COMBINED`, `renderTeamCategoriesXml()` and `WHAT_NOT_TO_SAVE_SECTION`, but not `TYPES_SECTION_INDIVIDUAL`.
- **Secrets.** It adds a rule that sensitive data, such as API keys or user credentials, never goes into shared team memory.
- **How to save:**
  - the file goes in the directory the type's scope calls for: private, the team root, or a team category subdirectory;
  - each directory has its own `MEMORY.md`, with the same entry format and ~150-character limit, and both indexes are loaded, with lines after 200 truncated;
  - `paths:` works as above, recommended for a bug or doc memory tied to files.

**`buildLoopHint(toolName, repeatCount)`**
- **What it says.** The agent repeated the same failing action, with the tool name in backticks, `repeatCount` times (written as the number followed by `×`), without success.
- **What it asks.** If there is a durable, non-obvious lesson about how to approach this kind of work, save it as a `` `feedback` `` memory: the rule, then `**Why:**` and `**How to apply:**`. If it was a one-off fix already in the code, save nothing and do not log the incident as a fix recipe. This is a deliberate exception to the "no fix recipes" exclusion.

### 8. Session memory

**Location.**
- **`getSessionMemoryDir()`** is `<CLAUDIN_CONFIG_DIR>/projects/<key>/<session id>/session-memory/`, and it always ends with the path separator.
  - `<key>` is the working directory with every character that is not a letter or a digit replaced by `-` (hashed when long). That is `getProjectDir(getCwd())` from the session-storage barrel: the same folder the session's transcript uses in the common case.
  - It follows `getCwd()` at call time, so a per-agent override (`runWithCwdOverride`) counts, and it follows the active session id.
  - It ignores the project directory a resumed session names (`switchSession(id, dir)`); see finding 9.
- **`getSessionMemoryPath()`** is `summary.md` in that directory.

**Reading.** `getSessionMemoryContent()` reads the file as UTF-8 at every call and returns it exactly; an empty file is `''`.
- It returns `null` when the file cannot be reached or read: missing, a file where a directory should be, a symlink loop, or no permission (`ENOENT`, `ENOTDIR`, `ELOOP`, `EACCES`, `EPERM`).
- Any other error rejects, for example `EISDIR` when a directory stands where the file should be.

**The last-summarized id.**
- It is process-wide and unset at start.
- `setLastSummarizedMessageId` replaces it, and `undefined` clears it.

**`DEFAULT_SESSION_MEMORY_TEMPLATE`**
- **Shape.** Ten sections, each a `# ` header line followed by one italic guidance line (`_…_`), with a blank line between sections and a newline at both ends.
- **The headers, exactly and in this order:**
  1. `# Session Title`
  2. `# Current State`
  3. `# Task specification`
  4. `# Files and Functions`
  5. `# Workflow`
  6. `# Errors & Corrections`
  7. `# Codebase and System Documentation`
  8. `# Learnings`
  9. `# Key results`
  10. `# Worklog`
- **The guidance each line gives, by intent:**
  - the title: a short, distinctive, information-dense title of 5-10 words;
  - the current state: what is being worked on now, pending tasks, next steps;
  - the task: what the user asked to build, design decisions, context;
  - the files: the important files, what they hold, why they matter;
  - the workflow: the usual shell commands, their order, how to read their output;
  - errors and corrections: errors met and how they were fixed, what the user corrected, approaches not to retry;
  - codebase documentation: the important components and how they fit;
  - learnings: what worked, what did not, what to avoid, without repeating other sections;
  - key results: any exact output the user asked for (an answer, a table, a document), repeated in full;
  - the worklog: a terse step-by-step record of what was tried and done.

**`isSessionMemoryEmpty(content)`**
- **True** when `content`, trimmed, equals the template, trimmed. Inner differences count, and so does anything written into it.
- **The template** is `<CLAUDIN_CONFIG_DIR>/session-memory/config/template.md` when that file exists, read at every call, and the default otherwise.
  - An empty template file makes blank content count as empty.
  - A template that exists but cannot be read (a directory, say) falls back to the default, and the error is logged.
- **The empty string** is not empty, because the default template is not blank.

**`truncateSessionMemoryForCompact(content)`**
- **Sections.** A section starts at a line beginning with `# ` (hash, space). `## ` sub-headers, `#tag` lines and indented hashes are body text.
- **The preamble.** Text before the first header is never cut.
- **The cap.** Each section's body is capped at `floor(2000 × bytes per token)` characters. The ratio is `getActiveModelBytesPerToken()` (`src/shared/tokenEstimation.ts`), the one the token estimator uses: 3.5 for Claude models gives 7,000.
- **Measuring the body.** The body is its lines joined by newlines; blank lines count.
  - A body within the cap is kept as it is, and exactly at the cap is within.
  - A longer one keeps whole lines from the top while each line plus its newline fits in the cap, then gets an empty line and a line saying the section was truncated. A first line longer than the cap leaves only the header and that note.
- **Independence.** Sections are capped independently, and those after a cut section come through whole.
- **The result.** `wasTruncated` is true when any section was cut. Content that needs no cut comes back byte-identical, the empty string included.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `executeExtractMemories` or `drainPendingExtraction` before `initExtractMemories` | resolves; no fork. Pinned in a fresh process |
| a sub-agent's turn, the switch off, auto memory off | no fork, and the turn does not count. Pinned |
| the main agent saved a memory with `Edit` or `Write` after the mark | no fork, the mark moves, the turn does not count. Pinned |
| the main agent saved one with `Patch`, `NotebookEdit` or a shell redirection | not recognized: the turn counts and may fork. Not pinned; finding 3 |
| the mark's message is gone (compaction) | every model-visible message is new again. Pinned. A memory the main agent saved in those messages is not seen; finding 2, not pinned |
| the fork throws | swallowed; nothing announced; the messages stay new; the cadence restarts. Pinned |
| a turn ends during a fork | held; only the latest is kept; one trailing fork later. Pinned |
| the fork never answers | the call that started it never settles; `drainPendingExtraction(t)` returns after `t`. Pinned |
| the fork names a path outside the memory directory in an `Edit` or `Write` | the call is denied, but the path is still announced. Not pinned; finding 1 |
| a symlink inside the memory directory | `Edit` and `Write` through it are allowed. Not pinned; finding 5 |
| the memory directory is missing | empty manifest; the fork still runs. Pinned |
| no new message since the last fork (the same context twice) | it still forks, telling the model `~0`. Not pinned |
| the session-memory file is missing, unreachable, or unreadable | `getSessionMemoryContent()` is `null`. Pinned |
| a directory stands at the session-memory file's path | rejects with `EISDIR`. Pinned |
| an unreadable custom template | falls back to the default. Pinned |
| Windows | the permission-denied read test is skipped there and when running as root. Paths use the platform separator |

## Security requirements

- **The fork writes only memory.** `Edit` and `Write` are allowed only for a string `file_path` inside the auto-memory directory. The directory's trailing separator is part of the check, so `…/memory-shadow/…` is outside; `..` segments are resolved lexically first, and relative paths are outside. Every other writing tool is denied, `Patch` and `NotebookEdit` included, and `Bash` only runs what the Bash tool itself classifies as read-only, which excludes network commands such as `curl`. All of this is pinned.
- **Reads are open.** `Read`, `Grep`, `Glob` and read-only `Bash` work on any path, in a fork that runs unattended and takes its cue from conversation content. See finding 6.
- **Team memory stays free of secrets.** The combined prompt forbids them, and the write tools' own team-memory secret guard (`checkTeamMemSecrets`, outside the unit) enforces it.
- **No transcript.** The fork runs with `skipTranscript`.
- **The session-memory directory ends with a separator,** because a string-prefix check grants reads under it.

## Tests that pin it

The suite, in `src/memory/extract/`:

| File | Tests | Pins |
|---|---|---|
| `extractMemories.characterization.test.ts` | 63 | sections 1 to 6 with the build flags off, and the permission policy with the real tools |
| `extractPrompts.characterization.test.ts` | 12 | section 7: facts, verbatim sections, where the count, manifest and hint land, the wire-proxy pairing, the combined prompt with `TEAMMEM` off |
| `sessionMemory.characterization.test.ts` | 29 | section 8 |
| `extractMemories.shipFlags.characterization.test.ts` | 1 (16 in its child) | the shipped build: the combined prompt, team files in the manifest, `teamCount`, the repeated-error trigger |
| `extractMemories.firstUse.characterization.test.ts` | 1 (3 in its child) | before `initExtractMemories`, and the id's initial value, in a fresh process |

- **The shared harness** is `__testutils__/extractionHarness.ts`. It gives each test a scratch directory with `CLAUDIN_CONFIG_DIR`, `HOME` and the project root in it, clears the memory switches, and resets settings. It replaces `runForkedAgent` with a double that records every request and answers from a script. The rest of `forkedAgent.ts` stays genuine, and the genuine module is put back after the file.
- **Two files re-run themselves in a child `bun test`.**
  - `shipFlags` runs with `--feature=TEAMMEM --feature=LOOP_ERROR_MEMORY_TRIGGER`, because the plain runner folds every flag to false.
  - `firstUse` runs alone, because "never initialized" exists once per process, and loading a second copy of the module would replace the real one in the coverage report.

  A failing child fails the parent test with the child's output.
- **Fixtures** live under `__fixtures__/rewrite/`:
  - `memory-dir/` holds typed, untyped and nested memory files and an index, and pins the manifest line format through the prompt;
  - `session-summary.md` is a filled summary, with a preamble, `## ` sub-headers and a `#tag` line;
  - `session-template.md` is a custom template.
- **Coverage,** with `bun test <suite> --coverage`, in-process:
  - `extractMemories.ts` 95.9%;
  - `prompts.ts` 70.3%. The rest is the combined prompt's body, which only runs with `TEAMMEM`; the flagged child reaches 99.0%;
  - `paths.ts`, `sessionMemoryUtils.ts` and `session/prompts.ts` 100%.
- **The probe spec** is `scripts/migrations/probes/rewrite-memory-extract.json`: 40 probes, 21 on `extractMemories.ts`, 8 on `prompts.ts`, 3 on `paths.ts`, 3 on `sessionMemoryUtils.ts` and 5 on `session/prompts.ts`. Each turns at least one test red; the flag-only probes and the start-up probe go red through the child runs.

**Outside the unit, what pins the prompt text:**
- `src/memory/memdir/memoryPrompt.test.ts` ("extraction prompts") uses targeted matches. The auto-only prompt contains `` `paths:` `` and not `## Team categories`, and the combined prompt contains `` `paths:` `` with the flag off.
- `scripts/bench/ab/wire-proxy.ts`: its `FORK_PROMPTS` holds the extraction prompt's opening words byte for byte, and `wire-proxy.test.ts` builds fixtures that start with them (lines 87 and 139). Change the list and the fixtures together with the opening. The same list has a second marker, attributed to `src/memory/session/prompts.ts`, for a session-memory prompt that no longer exists; it is stale.
- `src/agent/tools/__fixtures__/grepSamples/dup-heavy.txt` is a recorded grep output that contains one line of the old prompt module. It checks grep rendering, not this unit, and needs no change.
- No snapshot holds either prompt or the session template.

**Not pinned, and why:**
- **The wording and section order of the prompts.** The rewrite writes its own.
- **The template's guidance lines.** Only their shape and the 5-10-word fact are pinned; see finding 10.
- **The truncation note's wording.** Only its place, and the word "truncated", are pinned.
- **Remote mode.** Nothing can set it; see finding 7.
- **The drain timer being unref'd, and the 60-second default.** The suite only shows that the drain waits for a fork that takes tens of milliseconds.
- **The debug log lines.**
- **The rows marked "Not pinned" in the edge cases.** Those are findings whose decision is "fix".

## Out of scope

- **The fork itself** (`runForkedAgent`, `createCacheSafeParams`): `src/agent/coordinator/forkedAgent.ts`.
- **The memory directory and its switches:** `getAutoMemPath`, `isAutoMemPath`, `isAutoMemoryEnabled`, `isExtractMemoriesEnabled`, `getExtractionTurnInterval` and `isExtractModeActive`, all in `src/memory/memdir/paths.ts`. That is the `memory/memdir` unit.
- **The manifest scan and format:** `src/memory/memdir/memoryScan.ts`.
- **The loop detector:** `src/memory/extract/loopDetector.ts`, this project's own, with its own tests.
- **The shared prompt sections:** `src/memory/memdir/memoryTypes.ts`.
- **Rendering the notice,** and session-memory compaction (`src/agent/compact/sessionMemoryCompact.ts`).

## Findings

Each is left unpinned when its decision is "fix", so the rewrite can apply it.

1. **The notice lists attempts, not saves.** `writtenPaths` holds every path the fork named in an `Edit` or `Write` call, including calls that were denied (a path outside the memory directory) or that failed. Only a user who turned `notifyMemorySaved` on sees it. Decision: fix. List only paths inside the auto-memory directory whose call did not come back as an error. Nothing stored or configured depends on a denied path being announced.
2. **A compaction hides the main agent's saves.** When the mark's message is gone, every message counts as new, but the check for a memory the main agent saved finds nothing. So that turn forks anyway, and can duplicate the memory. Decision: fix. A missing mark means "look at every message" in both places.
3. **Saves through `Patch` go unseen.** Only `Edit` and `Write` calls count as the main agent saving a memory. A save through `Patch` (the tool this build prefers for multi-file edits), `NotebookEdit` or a shell redirection still lets the fork run. Decision: keep for parity. Recognizing a patch means parsing the patch envelope, which belongs to the Patch tool. Track.
4. **The permission policy's directory argument only shapes the message.** `Edit` and `Write` are checked against `getAutoMemPath()`, whatever `memoryDir` says, and the argument only appears in the denial text. Both callers pass `getAutoMemPath()`, so nobody observes the difference. Decision: fix. Check containment against the directory given, normalized and with its trailing separator, as the signature promises. The suite only uses the auto-memory directory, as the callers do.
5. **Security: a symlink escapes the memory directory.** Containment is lexical; symlinks are not resolved.
   - When the memory directory is project-local (`<git root>/.claudin/memory/`), a cloned repository can ship a symlink inside it. Resolving the directory verifies the directory's own real path, not its entries.
   - The unattended fork would then be allowed to write through that symlink to wherever it points.
   - The same check, `isAutoMemPath`, also grants the main agent's automatic write permission.

   Decision: keep for parity here. The hardening, checking the real path of the target's nearest existing ancestor, belongs in `isAutoMemPath` (the `memory/memdir` unit), so both paths close together. Report it to that unit.
6. **Security: the fork may read anything the user can.** `Read`, `Grep`, `Glob` and read-only `Bash` (`cat ~/.ssh/id_rsa` passes) work on any path, without a prompt, in a fork steered by conversation content. What it reads can then be written into a memory file: the team-memory secret guard covers team files, and nothing covers private ones. Decision: keep for parity. `autoDream`, the other caller, greps session transcripts outside the memory directory, so narrowing reads is not pure hardening. Track a per-caller read scope.
7. **The remote-mode gate reads a flag nothing sets.** Extraction is skipped in remote mode, but that flag's setter left with the `--remote` TUI path, so the gate is always open. Decision: fix, by dropping the gate. Nothing observable changes.
8. **Nothing writes session memory.** Session-memory extraction was deleted on 2026-09-25.
   - `summary.md` is only read: by compaction, behind `ENABLE_CLAUDE_CODE_SM_COMPACT`, and by the away summary.
   - `setLastSummarizedMessageId` is only ever called with `undefined`, so the id is always unset.
   - `DEFAULT_SESSION_MEMORY_TEMPLATE` has no importer.

   Decision: keep for parity. Callers not yet rewritten still call these exports. Removing the dead path belongs to their rewrites. Track.
9. **The session-memory location follows the working directory.** It is keyed on `getCwd()`, not on the session's project directory, so a change of working directory or a cross-project resume moves it while the transcript stays put. Nothing writes the file, and the read carve-out and the readers compute it the same way at the same moment. Decision: keep for parity (pinned).
10. **The empty check compares the whole template.** Rewording the default template's guidance lines changes which files count as "just the template". No build of this project ever wrote `summary.md` from it: the writer was off, then deleted. Decision: fix, by letting the rewrite write its own guidance lines. The headers, their order and the shape stay as pinned.

Observations that are not defects:
- **The auto-only prompt never reaches a fork in the shipped build,** since team memory follows auto memory.
- **`drainPendingExtraction` never runs in the shipped build.** Its caller is the headless path, where extraction mode is off, and the stop hook starts no extraction there either.
- **A failed fork restarts the cadence,** which acts as a back-off.

## Target design

- **One slice, split by responsibility.** Its callers see the same exports under the same paths.
  - **The trigger policy.** A pure decision from the gates' answers, the cadence count and the interval, the main-agent-saved signal, and the loop signal with its cooldown, to one of `gated`, `mainAgentSaved`, `throttled`, `fork(routine | loop | trailing)`. It is a discriminated union, tested directly.
  - **Transcript readers.** Pure functions over `Message[]`: the new-message count after a mark, the main agent's memory saves after a mark (one rule for a missing mark, finding 2), and the files a fork saved (finding 1).
  - **The permission policy.** A pure function of the tool's name and input and a memory directory, with Bash's read-only answer delegated to the tool. The containment check takes the directory it is given (finding 4).
  - **The orchestrator.** The state behind `initExtractMemories`: the mark, the count, the kept call, the in-flight set and the loop cooldown, as one explicit object. Its dependencies are narrow and have production defaults (`.claudin/rules/code-design.md`): the fork runner, the manifest reader and the settings reads. The characterization suite still drives the defaults through the exports.
  - **Prompts.** Prose apart from logic, one builder per variant sharing one opening, and facts from constants: tool names, `MEMORY.md` and the limits.
  - **Session memory.** Paths are pure over the config home, the working directory and the session id. The reader and the template loader do file I/O with `isENOENT`/`isFsInaccessible` from `src/shared/errors.ts`. Truncation is a pure function that takes the character cap, with the active model's cap as its default.
- **Types.** Explicit types for the decision, the fork request the unit builds, and the `memory_saved` payload, `teamCount` included instead of an ad-hoc widening.
- **Errors.** A failed fork or scan is logged and absorbed, never thrown to the stop hook. No `any`. Nothing is swallowed without a log line.

## Outcome

- **The gate.** In `src/memory/extract/fork/transcript.ts`, 2 lines of Claude Code opened the reader of failed calls: a set declared, then a loop over the messages. That reader now takes one message at a time, as the reader of file writes does, and the set is built from what each read returns. The file measures zero.
- **Residue, reviewed.** These lines of Claude Code stay. Each one is contract:
  - **`src/memory/extract/fork/forkRequest.ts`, 2 lines.** Two parameters of the function that builds the fork request. The hook context has the name and the type that `executeExtractMemories` gives it in the contract table. `canUseTool` is the field of the `runForkedAgent` request it fills, with the type that `createAutoMemCanUseTool` returns. Both types belong to modules outside the unit.
  - **`src/memory/extract/fork/permissions.ts`, 2 lines.** The case labels of `Edit` and `Write` in the tool policy. Each label holds only the name constant that the tool's own module exports, and section 4 gives the two tools one decision.
  - **`src/memory/extract/prompts.ts`, 7 lines.** The signatures of `buildExtractAutoOnlyPrompt` and `buildExtractCombinedPrompt` with their `existingMemories` parameter, from the contract table; the two shared sections that section 7 requires verbatim, `TYPES_SECTION_INDIVIDUAL` and `WHAT_NOT_TO_SAVE_SECTION`; and the `feature('TEAMMEM')` test, whose text the build matches to fold the flag.

  `prompts.ts` and `src/memory/session/sessionMemoryUtils.ts` were rewritten at their old paths, so the baseline did not flag them; they were reviewed by hand. `sessionMemoryUtils.ts` matched in 3 lines, the private variable behind the last summarized id and its getter. The variable was renamed, and the file measures zero.

  They go when the contract is redesigned, after every consumer has been rewritten.
