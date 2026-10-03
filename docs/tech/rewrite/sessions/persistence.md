# Spec: `sessions/persistence`

## Purpose

The writer of the session transcript. A session is a JSONL file under
`<config home>/projects/<project directory>/<session id>.jsonl` (the paths are
`sessions/storagePure`'s), and this unit is what puts lines in it:

- **Messages.** The conversation as it happens: each message stamped with the session, the working directory, the branch and the version, chained to the one before by `parentUuid`, and written once even when callers hand the same history over again.
- **Subagent lines,** into a file of their own per agent.
- **Side entries:** queue operations, file-history and attribution snapshots, context-collapse commits and snapshots.
- **Session metadata:** title, AI title, task summary, tag, agent name, color and setting, mode, worktree and PR link. It is cached for the current session, and re-appended at the end of the file after compaction, on resume and at exit, so that it stays inside the 64 KiB tail the session list reads.
- **Taking a message back out** (a tombstone after a failed stream).
- **The remote side,** which stays in the product: hydrating a session from Session Ingress for `-p --resume <url>` (behind `ENABLE_SESSION_PERSISTENCE`), mirroring each new message to it, and the CCR v2 internal-event writer and readers.

Resume, the session indexers, the session list and external tools read these
files, and users keep them across versions. **Every byte rule below is a
compatibility rule.**

The unit is five files under `src/sessions/persistence/`: `project.ts`,
`record.ts`, `metadata.ts`, `flush.ts` and `_helpers.ts`. Callers reach every
public name through the session-storage barrel (`src/sessions/sessionStorage.ts`),
except one test helper (see the contract).

## Public contract

These keep their names and types, because the modules not yet rewritten import
them. The barrel must keep re-exporting every name it exports today:
`src/sessions/__tests__/barrelExports.test.ts` pins the list with a snapshot.
"Tests" in the last column means the name is used only by test files.

**Writing messages** (`record.ts` today):

| Export | Signature | Used by |
|---|---|---|
| `recordTranscript` | `(messages: Message[], teamInfo?: TeamInfo, startingParentUuidHint?: UUID, allMessages?: readonly Message[]) => Promise<UUID \| null>` | `agent/QueryEngine.ts`, `agent/queryHelpers.ts`, `agent/hooks/useLogMessages.ts`, `agent/plans/plans.ts`, `agent/repl/{REPL.tsx,resumeSession.ts}`, `sessions/indexing/{liteMetadata,boundaryScan}.ts` |
| `TeamInfo` (type) | `{ teamName?: string; agentName?: string }` | nothing; kept for the barrel |
| `recordSidechainTranscript` | `(messages: Message[], agentId?: string, startingParentUuid?: UUID \| null) => Promise<void>` | `tools/AgentTool/runAgent.ts`, `commands/clear/conversation.ts`, `agent/tasks/LocalMainSessionTask.ts`, `agent/coordinator/forkedAgent.ts` |
| `recordQueueOperation` | `(queueOp: QueueOperationMessage) => Promise<void>` | `agent/messageQueueManager.ts` |
| `recordFileHistorySnapshot` | `(messageId: UUID, snapshot: FileHistorySnapshot, isSnapshotUpdate: boolean) => Promise<void>` | `shared/fs/fileHistory.ts` |
| `recordAttributionSnapshot` | `(snapshot: AttributionSnapshotMessage) => Promise<void>` | `platform/headless/print/controlLoop.ts`, `agent/repl/controllers/useOnSubmit.ts` |
| `recordContextCollapseCommit` | `(commit: { collapseId; summaryUuid; summaryContent; summary; firstArchivedUuid; lastArchivedUuid: string }) => Promise<void>` | nothing in this build; the loader reads the entries |
| `recordContextCollapseSnapshot` | `(snapshot: { staged: Array<{ startUuid; endUuid; summary: string; risk; stagedAt: number }>; armed: boolean; lastSpawnTokens: number }) => Promise<void>` | nothing in this build; the loader reads the entries |
| `removeTranscriptMessage` | `(targetUuid: UUID) => Promise<void>` | `agent/QueryEngine.ts`, `agent/repl/controllers/useOnQuery.ts` |
| `resetSessionFilePointer` | `() => Promise<void>` | `commands/clear/conversation.ts`, `agent/repl/{REPL.tsx,resumeSession.ts}`, `sessions/ui/ResumeConversation.tsx`, `sessions/lifecycle/restore/processResumedConversation.ts`, `platform/headless/print/sessionLoad.ts` |
| `adoptResumedSessionFile` | `() => void` | `agent/repl/{REPL.tsx,resumeSession.ts}`, `sessions/ui/ResumeConversation.tsx`, `sessions/lifecycle/restore/processResumedConversation.ts` |
| `flushSessionStorage` | `() => Promise<void>` | `agent/QueryEngine.ts`, `platform/remote/DesktopHandoff.tsx` |

**Metadata** (`metadata.ts` today):

| Export | Signature | Used by |
|---|---|---|
| `saveCustomTitle` | `(sessionId: UUID, customTitle: string, fullPath?: string, source?: 'user' \| 'auto') => Promise<void>` | `commands/rename/rename.ts`, `commands/branch/branch.ts`, `sessions/ui/SessionsScreen.tsx`, `permissions/ui/ExitPlanModePermissionRequest` |
| `saveAiGeneratedTitle` | `(sessionId: UUID, aiTitle: string) => void` | `platform/headless/print/settingsControlHandlers.ts`, `agent/repl/controllers/useOnQuery.ts` |
| `saveTaskSummary` | `(sessionId: UUID, summary: string) => void` | nothing; kept for the barrel |
| `saveTag` | `(sessionId: UUID, tag: string, fullPath?: string) => Promise<void>` | tests |
| `linkSessionToPR` | `(sessionId: UUID, prNumber: number, prUrl: string, prRepository: string, fullPath?: string) => Promise<void>` | `tools/shared/gitOperationTracking.ts` |
| `saveAgentName` | `(sessionId: UUID, agentName: string, fullPath?: string, source?: 'user' \| 'auto') => Promise<void>` | `commands/rename/rename.ts`, `permissions/ui/ExitPlanModePermissionRequest` |
| `saveAgentColor` | `(sessionId: UUID, agentColor: string, fullPath?: string) => Promise<void>` | `commands/color/color.ts` |
| `saveAgentSetting` | `(agentSetting: string) => void` | `platform/main/action/setupAgent.ts`, `platform/headless/print/runHeadless.ts` |
| `cacheSessionTitle` | `(customTitle: string) => void` | `platform/main/action/setupAgent.ts` |
| `saveMode` | `(mode: 'coordinator' \| 'normal') => void` | `platform/main.tsx`, `commands/clear/conversation.ts`, `agent/repl/resumeSession.ts`, `sessions/ui/ResumeConversation.tsx`, `sessions/lifecycle/restore/coordinatorMode.ts`, `platform/headless/print/sessionLoad.ts` |
| `saveWorktreeState` | `(worktreeSession: PersistedWorktreeSession \| null) => void` | `tools/{EnterWorktreeTool,ExitWorktreeTool}`, `permissions/ui/WorktreeExitDialog.tsx`, `commands/clear/conversation.ts`, `agent/repl/{REPL.tsx,resumeSession.ts}`, `sessions/lifecycle/restore/worktree.ts`, `platform/setup.ts` |
| `getCurrentSessionTitle` | `(sessionId: SessionId) => string \| undefined` | `agent/repl/REPL.tsx`, `commands/resume/resume.tsx`, `platform/status/StatusLine.tsx`, `platform/settings/ui/Status.tsx`, `platform/bridge/initReplBridge.ts`, `shared/proc/gracefulShutdown.ts`, `permissions/ui/ExitPlanModePermissionRequest` |
| `getCurrentSessionTag` | `(sessionId: UUID) => string \| undefined` | tests |
| `getCurrentSessionAgentColor` | `() => string \| undefined` | `terminal/tips/tipRegistry.ts` |
| `restoreSessionMetadata` | `(meta: { customTitle?; tag?; agentName?; agentColor?; agentSetting?: string; mode?: 'coordinator' \| 'normal'; worktreeSession?: PersistedWorktreeSession \| null; prNumber?: number; prUrl?; prRepository?: string }) => void` | `agent/repl/{REPL.tsx,resumeSession.ts}`, `sessions/ui/ResumeConversation.tsx`, `sessions/lifecycle/restore/processResumedConversation.ts`, `platform/headless/print/sessionLoad.ts` |
| `clearSessionMetadata` | `() => void` | `commands/clear/conversation.ts`, `agent/repl/{REPL.tsx,resumeSession.ts}` |
| `reAppendSessionMetadata` | `() => void` | `agent/compact/compact.ts`, `agent/repl/resumeSession.ts`, `platform/headless/print/sessionLoad.ts` |

**The writer object and the remote side** (`project.ts` today):

| Export | Signature | Used by |
|---|---|---|
| `getProject` | `() => Project` | `agent/cost-tracker.ts` (required lazily, calls `reAppendCostState()`); tests read `sessionFile` and `currentSessionWorktree` |
| `hydrateRemoteSession` | `(sessionId: string, ingressUrl: string) => Promise<boolean>` | `platform/headless/print/sessionLoad.ts` |
| `hydrateFromCCRv2InternalEvents` | `(sessionId: string) => Promise<boolean>` | `platform/headless/print/sessionLoad.ts`, `platform/headless/remoteIO.ts` |
| `setInternalEventWriter` | `(writer: (eventType: string, payload: Record<string, unknown>, options?: { isCompaction?: boolean; agentId?: string }) => Promise<void>) => void` | `platform/headless/remoteIO.ts` |
| `setInternalEventReader` | `(reader: InternalEventReader, subagentReader: InternalEventReader) => void`, where a reader is `() => Promise<{ payload: Record<string, unknown>; agent_id?: string }[] \| null>` | `platform/headless/remoteIO.ts` |
| `resetProjectForTesting` | `() => void` | tests, `sessions/__testutils__/restoreHarness.ts` |
| `resetProjectFlushStateForTesting` | `() => void` | tests |
| `setSessionFileForTesting` | `(path: string) => void` | tests |
| `setRemoteIngressUrlForTesting` | `(url: string) => void` | this unit's suite |

**Straight from `src/sessions/persistence/_helpers.ts`:**

| Export | Signature | Used by |
|---|---|---|
| `appendEntryToFile` | `(fullPath: string, entry: Record<string, unknown>) => void` | `src/sessions/sessionRestore.costState.test.ts` |

**Structure constraints:**
- **What `getProject()` must offer.** The object it returns must keep a readable and writable `sessionFile: string | null`, a readable `currentSessionWorktree: PersistedWorktreeSession | null | undefined`, and `reAppendCostState(): void` (synchronous: it runs from the process `exit` handler). Everything else on it is internal and may go.
- **One writer per process.** Every export acts on the same writer. `resetProjectForTesting()` drops it, and the next call builds a fresh one: no open file, no cache, no queue.
- **`appendEntryToFile`** writes one line synchronously, as section 8 describes. Only the cost-state test imports it.
- **Lazy loading.** `src/agent/cost-tracker.ts` requires the writer lazily, because the writer reaches the cost tracker through the message modules. Keep that cycle loadable.

## Observable behaviour

### 1. When the file appears

- **The first user or assistant message creates it.** Until then, nothing is created, whatever is recorded. Recorded system, attachment and side entries are held in memory.
- **What happens when the file opens.** The cached metadata is written at once (section 7), then the held entries in the order they came, then the messages of the call that opened it. A held message joins the deduplication (section 4) when it is written, so the parentUuid of the opening message points at it.
- **The path.** `getTranscriptPath()` at the moment the file opens. From then on `getProject().sessionFile` holds that path until `resetSessionFilePointer()` or `adoptResumedSessionFile()`, and every later line of the current session goes there, even if the session id or the cwd changes.
- **`resetSessionFilePointer()`** forgets the open file and drops the held entries. The next user or assistant message opens `getTranscriptPath()` again, normally the file of a session switched to in the meantime.
- **`adoptResumedSessionFile()`** makes `getTranscriptPath()` the open file without writing a message, and re-appends the cached metadata at its end right away. Unlike every other re-append, it does not re-read the title from the file first (section 7), so a `--name` title is the one written. The tag is still re-read. Later messages go to the same file, and no metadata is written again when the first one arrives.
- **Modes.** A new project directory is created `0700` and a new transcript `0600`, except in the case of finding 1.

### 2. When lines reach the disk

- **The queue.** Messages and side entries are queued per file and written in batches, appended in the order they were recorded.
- **The timing.** A batch is written about 100 ms after the first entry queued since the last batch. The interval drops to 10 ms for good once a remote ingress URL or an internal event writer is set.
- **When `recordTranscript` resolves,** its lines may still be queued. `flushSessionStorage()` writes everything queued now and resolves once it is on disk. It also waits for removals in progress.
- **Writes that are not queued.** Metadata saves (section 6) and re-appends (section 7) are written synchronously, the moment they are called. So a save made while messages are still queued lands before them.
- **Errors.** When a batch cannot be written (the directory cannot be created, for one), `flushSessionStorage()` rejects with the file-system error, and that batch's lines are lost (finding 6).

### 3. What a message line carries

Each message is one line: `JSON.stringify` of an object followed by LF.

**The members, in this order:**
1. `parentUuid` and `logicalParentUuid`, as the chain rules below set them;
2. `isSidechain`, `teamName` and `agentName` (from `teamInfo`), `promptId`, and `agentId`;
3. then every member of the message itself, in its own order;
4. then the session stamp: `userType`, `entrypoint`, `cwd`, `sessionId`, `version`, `gitBranch`, `slug`.

`JSON.stringify` drops members whose value is undefined, so the line opens with `{"parentUuid":` unless the message is missing that key.

**The values:**
- **`isSidechain`** is false for `recordTranscript` and true for `recordSidechainTranscript`.
- **`agentId`** is the one given to `recordSidechainTranscript`.
- **`promptId`** is `getPromptId()` on user messages only.
- **`userType`** is `getUserType()`, which is always `'external'`.
- **`entrypoint`** is `CLAUDE_CODE_ENTRYPOINT`.
- **`cwd`** is the current working directory (`getCwd()`), not the original one. The file stays where it was opened.
- **`sessionId`** is `getSessionId()`.
- **`version`** is the build's version, and `'unknown'` when the source runs unbuilt, as under `bun test`.
- **`gitBranch`** is the branch checked out in the working directory, read once per call, and `'HEAD'` outside a repository.
- **`slug`** is the plan slug cached for the session.

**Who wins.** The session stamp always replaces what the message carries, and a stamp that is unset removes the carried member (`entrypoint`, `slug`). Every other member the message carries, `parentUuid`, `isSidechain` and `agentId` included, wins over what the writer computed (finding 7).

**What is written.** Messages go through `cleanMessagesForLogging` (storagePure). Progress messages are never written, some attachments are left out, and `isVirtual` is dropped.

**The chain:**
- **The first message of a call** hangs off `startingParentUuidHint` (or the given parent for `recordSidechainTranscript`), and otherwise off the last message already recorded that leads the call (section 4), and otherwise off nothing (`null`).
- **Each next message** hangs off the previous message of the call. Every type counts here except progress.
- **A user message with `sourceToolAssistantUUID`** (a tool result) hangs off that assistant message instead. The chain then continues from the tool result.
- **A compact boundary** (`type: 'system'`, `subtype: 'compact_boundary'`) has `parentUuid: null` and `logicalParentUuid` set to the parent it would have had, when there was one in this call. Messages after it hang off the boundary.

The fixture `src/sessions/persistence/__fixtures__/rewrite/session.jsonl`
pins a whole session byte for byte. Its temp root is replaced by `<root>`, and
its version is `'unknown'`. It holds:
- the metadata written when the file opened (title, mode);
- a queue operation held until then;
- a prompt, an assistant tool call, and a tool result with its raw output;
- a file-history snapshot and an attribution snapshot;
- a compact boundary and a prompt recorded with team info.

### 4. Recording a conversation that is partly on disk

Callers hand `recordTranscript` the whole conversation again and again. The
rule that keeps the file free of duplicates:

- **What counts as recorded.** A uuid counts as recorded when it is in the session's transcript on disk, read once per session and remembered (`clearSessionMessagesCache()` forgets it), or when this process has written it to the main file since.
- **Recorded messages are skipped.**
- **Recorded messages at the start of the call** move the starting parent to themselves, progress excepted. Those after the first new message do not: after compaction the caller passes the new boundary and summary first, then kept messages that are already on disk, and the boundary must stay at `parentUuid: null`.
- **The result** is the uuid of the last new message written, progress excepted. When nothing new was written, it is the starting parent (a recorded message at the start of the call, or else the hint), and otherwise `null`.
- **A new process,** or a cleared memo, reads what is on disk, so a message already in the file is not written again.
- **Deduplication is by `uuid` only.** Queue operations and side entries (section 5) are never deduplicated.

### 5. Subagent lines and side entries

**Subagent lines.**
- **A line with `isSidechain` true and an `agentId`** goes to `getAgentTranscriptPath(agentId)`, which is `<project dir>/<session id>/subagents/agent-<agentId>.jsonl`. The directory is created `0700` when missing.
- **Agent lines are never deduplicated.** Each call writes them again, even uuids the main transcript has, because forks inherit their parent's messages with the same uuids. Agent lines never count as recorded for the main file either.
- **`recordSidechainTranscript` without an agent id** writes sidechain lines to the main file, with the main file's deduplication.
- **Subagent turns never set the last prompt** (section 7).

**Side entries** are written whole, as given, in their own key order. Like
messages, they are held until the file opens.

| Call | Line |
|---|---|
| `recordQueueOperation(op)` | `op` as given |
| `recordFileHistorySnapshot(id, snapshot, update)` | `{"type":"file-history-snapshot","messageId":…,"snapshot":…,"isSnapshotUpdate":…}`, with `Date` values as ISO strings |
| `recordAttributionSnapshot(snapshot)` | `snapshot` as given |
| `recordContextCollapseCommit(commit)` | `{"type":"marble-origami-commit","sessionId":…, ...commit}` |
| `recordContextCollapseSnapshot(s)` | `{"type":"marble-origami-snapshot","sessionId":…, ...s}` |

The two context-collapse entries are skipped when there is no session id.

### 6. Metadata saves

**The lines.** Each save appends one line synchronously to the session's
transcript. The fixture `metadata.jsonl` pins all seven:

| Save | Line |
|---|---|
| `saveCustomTitle(id, title, path?, source?)` | `{"type":"custom-title","customTitle":…,"sessionId":…}` |
| `saveAiGeneratedTitle(id, title)` | `{"type":"ai-title","aiTitle":…,"sessionId":…}` |
| `saveTaskSummary(id, summary)` | `{"type":"task-summary","summary":…,"sessionId":…,"timestamp":<now, ISO>}` |
| `saveTag(id, tag, path?)` | `{"type":"tag","tag":…,"sessionId":…}` |
| `linkSessionToPR(id, n, url, repo, path?)` | `{"type":"pr-link","sessionId":…,"prNumber":…,"prUrl":…,"prRepository":…,"timestamp":<now>}` |
| `saveAgentName(id, name, path?, source?)` | `{"type":"agent-name","agentName":…,"sessionId":…}` |
| `saveAgentColor(id, color, path?)` | `{"type":"agent-color","agentColor":…,"sessionId":…}` |

**Where the line goes.**
- **With a path,** to that path.
- **Without one,** to `getTranscriptPathForSession(id)`: the current session's transcript, or for another id the file of that id in the project of the original cwd.
- **A missing directory** is created `0700`, and the file is created when missing. These saves create a file that holds only metadata when the session has none yet, and they ignore the persistence switch (finding 2).
- **`source`** has no effect.

**The cache, for the current session id only.**
- **What is cached.** Title, tag, agent name, agent color, and the three PR fields.
- **What is not.** `saveAiGeneratedTitle` and `saveTaskSummary` are never cached or re-appended.
- **`saveAgentName`** also renames the session's process record (`updateSessionName`, `sessions/lifecycle`), without waiting.

**Cached only, written when the file opens or at the next re-append:**
- `cacheSessionTitle(title)`, `saveAgentSetting(setting)` and `saveMode(mode)`;
- `saveWorktreeState(ws)`, which keeps exactly the ten fields of `PersistedWorktreeSession` (`originalCwd`, `worktreePath`, `worktreeName`, `worktreeBranch`, `originalBranch`, `originalHeadCommit`, `sessionId`, `tmuxSessionName`, `hookBased`, `attached`, in that order) or `null`. When the file is already open, it also appends `{"type":"worktree-state","worktreeSession":…,"sessionId":…}` at once.

**The getters.**
- **`getCurrentSessionTitle(id)` and `getCurrentSessionTag(id)`** return the cached value for the current session id, and `undefined` for any other.
- **`getCurrentSessionAgentColor()`** takes no id.
- **`getProject().currentSessionWorktree`** is `undefined` when never set, `null` after leaving a worktree, and the object while inside one.

**`restoreSessionMetadata(meta)`** fills the cache from a resumed transcript:
- **The title** is set only when none is cached, so `--name` wins. An empty title is ignored.
- **The tag** is set when given, and an empty tag clears it. An absent tag leaves it.
- **Agent name, color, setting, mode, PR URL and PR repository** are set when non-empty, and otherwise left as they are.
- **The worktree** is set when given, `null` included.
- **The PR number** is set when given, `0` included.

**`clearSessionMetadata()`** empties the whole cache, the last prompt included.
Nothing on disk changes.

### 7. Re-appending the metadata

**When it happens.** `reAppendSessionMetadata()` runs after compaction, on
resume, when the file opens, and at exit. It writes nothing until a file is
open or without a session id. Otherwise it appends synchronously, in this
order, each line only when its value is set:

1. `last-prompt`: `{"type":"last-prompt","lastPrompt":…,"sessionId":…}`;
2. `custom-title`, `tag`, `agent-name` and `agent-color`, shaped as in section 6;
3. `agent-setting`: `{"type":"agent-setting","agentSetting":…,"sessionId":…}`;
4. `mode`: `{"type":"mode","mode":…,"sessionId":…}`;
5. `worktree-state`, written whenever the worktree was ever set, `null` included;
6. `pr-link`, only when the number, the URL and the repository are all set, with a fresh timestamp.

The fixture `reappended.jsonl` pins the full block.

**Absorbing what another process wrote.** Before writing, it reads the last
64 KiB of the file. The SDK may have renamed or tagged the session meanwhile.
- **Which lines count.** The last line that begins exactly with `{"type":"custom-title"` gives the cached title, and the last line that begins with `{"type":"tag"` gives the tag.
- **An empty value** clears the cache, and nothing is written for it.
- **What does not count.** Lines with another key first, a space after the colon, leading whitespace, or the member nested deeper, and lines further back than 64 KiB.
- **`adoptResumedSessionFile`** skips this for the title only.
- **A hydrated transcript** (section 10) is absorbed the same way, so its title is re-stamped when its first new message opens the file.

**The last prompt.** After each main-thread call to `recordTranscript`, the
cache takes the first meaningful user text of the messages written. "Meaningful"
follows `getFirstMeaningfulUserMessageTextContent` (storagePure).
- **Flattening.** Every LF becomes a space, and the ends are trimmed.
- **Length.** Over 200 characters, the text is cut to 200, trimmed again, and given `…` (U+2026).
- **No text.** A call without such text leaves the previous value.
- **Subagents.** Subagent calls never change it.
- **Timing.** It is cached after the call's messages are queued, so the call that opens the file does not write it.

**The running cost.** `getProject().reAppendCostState()` appends the session's
`cost-state` entry from `getCostStateEntryFor` (`agent/cost-tracker.ts`), whose
shape the cost tracker owns. It does so when a file is open and persistence is
on.

**At exit.** The writer registers one cleanup with the process's cleanup
registry, the first time it is built. The cleanup:
1. flushes the queue;
2. re-appends the metadata;
3. re-appends the cost.

The two re-appends are best-effort: an error in either is swallowed (the second
is logged).

### 8. Persistence switched off

**When.** Persistence is off when any of these holds:
- `NODE_ENV` is `test` and `TEST_ENABLE_SESSION_PERSISTENCE` is not truthy;
- the settings say `cleanupPeriodDays: 0`;
- the session was started with `--no-session-persistence` (`isSessionPersistenceDisabled()`);
- `CLAUDIN_SKIP_PROMPT_HISTORY` is truthy.

"Truthy" is `1`, `true`, `yes` or `on`, in any case. All four are read at
every call.

**What it stops.**
- **Messages and side entries:** nothing is held, queued or written, and no file or directory is created.
- **Opening the file:** it never happens, so the cached metadata is not written then.
- **The cost re-append** writes nothing.

**What it does not stop.** The metadata saves, `saveWorktreeState` on an
already-open file, and `reAppendSessionMetadata` on an open file (finding 2).

A process outside tests (`NODE_ENV` unset) persists by default.

### 9. Removing a message: `removeTranscriptMessage(uuid)`

- **Before the file opens,** a held entry with that uuid is dropped and never written.
- **Otherwise,** everything queued is written first, so a message still in the queue is removed rather than written back afterwards.
- **The usual case.** The last 64 KiB of the file are searched for the last occurrence of `"uuid":"<uuid>"`. A `parentUuid` naming it does not match. When the whole line holding it lies inside that window, the line is cut out: the file is truncated at the line's start and the lines after it are written back unchanged. Every other byte stays the same.
- **Further back, or a line longer than 64 KiB.** When the file is at most 50 MiB, it is read whole, every line whose parsed top-level `uuid` is the target is dropped, and the rest is written back. Blank lines and lines that do not parse are kept, and so is the trailing LF.
- **When it is skipped.** A file over 50 MiB is left alone, with a debug warning.
- **Errors.** A missing or empty file, or any error, is ignored. The call never rejects.
- **Not a tombstone.** Nothing is appended in place of the line.

### 10. Session Ingress: `-p --resume <url>`

**`hydrateRemoteSession(sessionId, ingressUrl)`:**
- **The switch.** It switches the session to `sessionId`.
- **The fetch.** It sends `GET ingressUrl` with `Authorization: Bearer <token>`. The token is `CLAUDE_CODE_SESSION_ACCESS_TOKEN`, or the token file read by `sessions/sessionIngressAuth.ts`. The answer is `{ "loglines": Entry[] }`.
- **The write.** It creates the project directory `0700` and writes `<project dir>/<sessionId>.jsonl` (`0600` when new), one `JSON.stringify(entry)` plus LF per entry. That replaces whatever was there. The fixture pair `ingress-loglines.json` and `hydrated.jsonl` pins it.
- **The result** is true when at least one entry came back.
- **A failed fetch** (401, 5xx, a network error, a malformed answer, no token) counts as zero entries. The local file is then emptied, and the result is false (finding 4). A 404 is the same.
- **Any error after the fetch** returns false and writes nothing more.
- **In every case, the URL is kept** as the session's ingress URL. That turns the mirroring below on.

**Mirroring.** With an ingress URL set and `ENABLE_SESSION_PERSISTENCE` truthy,
each new main-file message is sent to the URL after it is queued locally:
- **Which lines.** The four message types (`user`, `assistant`, `attachment`, `system`). Not metadata, side entries, agent lines, or messages skipped as recorded.
- **The request.** `PUT` with the line's object as its JSON body, `Authorization: Bearer <token>` and `Content-Type: application/json`. `Last-Uuid` is the uuid of the session's previous accepted entry (after hydration, the last hydrated one), and is absent for the first.
- **Ordering.** `recordTranscript` waits for each PUT, so it resolves after the server accepted them.
- **The client's rules.** Retries, 409 handling and the `Last-Uuid` bookkeeping belong to `src/providers/transport/sessionIngress.ts`.
- **A PUT that finally fails** shuts the process down with exit code 1 (finding 5).
- **No mirroring** without `ENABLE_SESSION_PERSISTENCE`, during shutdown, or when an internal event writer is set.

### 11. CCR v2 internal events

**`setInternalEventWriter(writer)`.** From then on, each new main-file message
(the same set as the mirroring) is also given to
`writer('transcript', line, options)`:
- **`line`** is the object written to the file.
- **`options`** is `{}`, plus `isCompaction: true` for a compact boundary, plus `agentId` when the line carries one.
- **Precedence.** The writer replaces Session Ingress, and it does not need `ENABLE_SESSION_PERSISTENCE`.
- **Errors.** A writer that throws is ignored, and the local line is still written.

**`setInternalEventReader(reader, subagentReader)`** stores both readers for
`hydrateFromCCRv2InternalEvents(sessionId)`, which:
1. switches the session to `sessionId` in every case;
2. returns false with no reader, or when the reader returns `null`, and writes nothing;
3. otherwise writes every event's `payload` as a line to the session's transcript (directory `0700`, file `0600`), replacing it. The output matches `hydrated.jsonl` for the same entries;
4. groups the subagent reader's events by `agent_id`, and writes each group, in order, to that agent's transcript, replacing it. Events with no or an empty `agent_id` are dropped, and a `null` or empty answer writes nothing;
5. returns true when there was at least one foreground event. Zero events leave an empty file and return false.

**Errors.** An error with the message `CCRClient: Epoch mismatch (409)` is
re-thrown, and any other error returns false.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| Only system or attachment messages recorded so far | no file; they are written ahead of the first user or assistant message |
| The same history recorded twice | each uuid once in the main file |
| A compact boundary first in a call with no hint | `parentUuid: null` and no `logicalParentUuid` (as in the fixture) |
| `recordTranscript([])` | `null`, or the hint when one is given |
| The project directory cannot be created | `flushSessionStorage()` rejects with the fs error; the batch is lost |
| A message carrying `isSidechain: true` and an `agentId` passed to `recordTranscript` | written to that agent's file (finding 7) |
| `removeTranscriptMessage` on a missing file | resolves; no file is created |
| An external `custom-title` with `""` in the tail | the cached title is cleared and not re-appended |
| `saveCustomTitle` for another session that has no file | a metadata-only file is created for it |
| `saveWorktreeState` before the file opens | cache only; written when the file opens |
| `restoreSessionMetadata({ customTitle })` after `cacheSessionTitle` | the cached (`--name`) title stays |
| Hydration that fails | an empty local transcript, `false`, mirroring still on |
| A PUT rejected for good | the process exits with code 1 |
| A CCR v2 subagent event without `agent_id` | dropped |
| Two lines removed from the same file at once | each removal runs on the file as the other left it; not pinned |
| A batch over 100 MiB | written in several appends; not pinned |

## Security requirements

**Pinned by the tests:**
- **Private files.** Transcripts the queue creates are `0600`, and project, session and `subagents` directories `0700`. Hydrated files are `0600` too. A metadata save into an existing directory creates its file `0600`.
- **The token.** The ingress token is sent only as a Bearer header to the URL the caller gave.
- **Bounded memory on removal.** The usual removal reads at most 64 KiB, and the full rewrite is refused above 50 MiB.

**Not pinned:**
- **Finding 1:** a metadata save that creates the directory leaves its file at the default mode.
- **Path components are joined without validation.**
  - **Session ids** are UUIDs. `-p --resume <url>` uses a random one (`src/sessions/sessionUrl.ts`).
  - **Agent ids from the CCR v2 server** go into a file name as given, so an `agent_id` holding `/` or `..` would write outside `subagents/`. The server is Anthropic's, but finding 9 hardens it.
- **The ingress URL** is not checked here; it comes from the user's `--resume` argument.

## Tests that pin it

**The characterization suite, 84 tests in three files,** with a shared harness
in `src/sessions/__testutils__/persistenceSandbox.ts`.
- **The harness.** Each test gets a fresh temp root with its own `CLAUDIN_CONFIG_DIR` and project, and a fresh session id. Git runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and `HOME` in the temp root.
- **Coverage of the old code:** `_helpers.ts` 97.4% of lines, `flush.ts` 100%, `metadata.ts` 100%, `project.ts` 94.7%, `record.ts` 100%.

**The files:**
- **`src/sessions/persistence.characterization.test.ts`** (45 tests): when and where the file appears, the queue, the line format and the chain, deduplication and the result, subagent files, side entries, the persistence switch, removal, and the file pointer.
- **`src/sessions/persistence.metadata.characterization.test.ts`** (24): the save lines, the cache and the getters, the restore rules, the re-append and the tail absorption, the last prompt, adoption, and the cost re-append. One test runs the exit cleanup in a child `bun` process with no `NODE_ENV`.
- **`src/sessions/persistence.remote.characterization.test.ts`** (15): Session Ingress against a local `Bun.serve`, the exit on a rejected PUT (in a child process), and the CCR v2 writer and readers.

**The fixtures,** in `src/sessions/persistence/__fixtures__/rewrite/`, all
written by the real API:
- `session.jsonl`, `metadata.jsonl` and `reappended.jsonl`;
- `ingress-loglines.json` (the server's answer, four lines of `session.jsonl`) and `hydrated.jsonl` (the file both hydrations must produce).

**The probe spec,** `scripts/migrations/probes/rewrite-sessions-persistence.json`:
40 probes over all five files. Every one turns the suite red.

**Existing tests,** this project's own, which stay and must keep passing:
- `src/sessions/__tests__/{project,characterization,resumeRoundTrip,pure}.test.ts`;
- `src/sessions/resumePrefixDeterminism.test.ts`;
- `src/sessions/sessionRestore.costState.test.ts`;
- the `sessions/lifecycle` and headless `sessionLoad` characterization suites, which write through this unit.

**Model-facing text.** None; no prompt snapshot depends on this unit.

**Not pinned, and why:**
- **The 100 MiB batch split.** It needs over 100 MiB of queued lines.
- **No mirroring during shutdown.** It needs a shutdown in progress.
- **The writing of a line for another session id.** No export reaches it (`getProject().appendEntry` is internal).
- **The behaviour findings 1 to 3, 6 (the timer path), 8 and 9 change,** so that the suite passes on both the old and the new code.

## Out of scope

- **`source` on `saveCustomTitle` and `saveAgentName`.** It has no effect. Keep the parameter for its callers, and ignore it.
- **The other members of the object `getProject()` returns.** Apart from the three named in the contract, they are internal: the queue, the held entries, the remote URL, the readers and writer, and writing to another session's file.
- **`resetProjectFlushStateForTesting`.** It survives only for its three test callers. With a fresh writer per `resetProjectForTesting()`, it can become a no-op.
- **`TeamInfo`, `saveTaskSummary`, `saveTag`, `getCurrentSessionTag`, `recordContextCollapse*` and `setRemoteIngressUrlForTesting`.** They have no production caller, but they stay for the barrel, and the loader reads their entries.

## Findings

1. **A metadata save that creates the project directory leaves a world-readable file.**
   - **The defect.** When the directory is missing, the save creates it `0700` but writes the file with the default mode (`0644` under umask 022). The queue writer and hydration create `0600`. `/rename` or `/color` before the first message, or a PR link, can create that file.
   - **Decision: fix**, as pure hardening: always create transcripts `0600`. Not pinned.
2. **Metadata writes ignore the persistence switch.**
   - **The defect.** With persistence off, these still write: the `save*` functions, `saveWorktreeState` on an open file, and the re-appends from `adoptResumedSessionFile` and the exit cleanup. So `/rename` under `--no-session-persistence` (or `cleanupPeriodDays: 0`, or `CLAUDIN_SKIP_PROMPT_HISTORY`) creates a metadata-only transcript, which the session list shows.
   - **Decision: fix.** With persistence off, saves for the current session update the cache only, and re-appends write nothing. Saves for another session's existing file keep writing, since the user asked for that one. Not pinned.
3. **Removal can take out the wrong line.**
   - **The defect.** The usual removal matches `"uuid":"<id>"` at any depth. When a later line within 64 KiB holds that member in a nested object (a tool result's raw output that quotes a message, say), that later line is cut instead of the target, and the target stays.
   - **Decision: fix.** Match only the top-level member. Nothing stored or calling depends on removing the wrong line. Not pinned.
4. **A failed hydration empties the local transcript.**
   - **The defect.** A 401, a 5xx, a network error, a malformed answer or a missing token all count as an empty session, so the local copy is replaced by an empty file and the session starts empty.
   - **Decision: keep for parity.** In CCR the server is authoritative. Loading a stale local copy would chain new lines to a history the server lacks, and every PUT would then fight a 409. Pinned (the 401 case).
5. **A rejected PUT ends the process with exit code 1.** **Decision: keep for parity.** The remote transcript is the session's durable copy in CCR, and continuing would lose turns silently. Pinned.
6. **A failed batch write loses its lines.**
   - **What callers see.** `flushSessionStorage()` rejects with the error, and the lines of that batch are gone.
   - **When the timer drains instead,** the rejection is unhandled.
   - **Decision: keep for parity** for `flushSessionStorage()`, which `QueryEngine` awaits (pinned). Fix the timer path to log the error instead of leaving an unhandled rejection (not pinned).
7. **A message's own members override the chain fields.**
   - **The defect.** `parentUuid`, `isSidechain`, `agentId`, `teamName` and `promptId` carried by a message win over what the writer computed. A message carrying `isSidechain: true` with an `agentId` is routed to that agent's file even through `recordTranscript`.
   - **Decision: keep for parity.** Resume, fork and agent paths hand in messages that carry these on purpose. The stamp set (`userType`, `entrypoint`, `cwd`, `sessionId`, `version`, `gitBranch`, `slug`) always wins, and an unset stamp removes the carried value. Pinned.
8. **The last prompt keeps carriage returns.** Only LF is flattened, as in storagePure finding 5. **Decision: fix.** Flatten CR and CRLF too; the value is display-only. Not pinned.
9. **CCR v2 agent ids are joined into a path unchecked.** **Decision: fix, as hardening.** Drop subagent events whose `agent_id` is not a single safe path segment. Real ids are `a` plus hex. Not pinned.
10. **Agent lines are written again on every call.**
    - **The defect.** A repeated `recordSidechainTranscript` with the same messages duplicates them in the agent file.
    - **Decision: keep for parity.** Forks share uuids with the main transcript on purpose, and the agent-transcript loader keys messages by uuid. Pinned.

## Target design

- **Split by responsibility,** inside `src/sessions/persistence/`:
  - **A line formatter** (pure): the stamp, the chain rules, and the boundary and tool-result parents.
  - **A deduplicating recorder** that turns a call into lines and a result.
  - **A per-file write queue** with an explicit interval: 100 ms, or 10 ms once remote.
  - **A metadata cache** with one ordered list of re-appended entries, so the order lives in one place.
  - **A remover.**
  - **A remote module** for ingress hydration, mirroring and CCR v2. It stays in the product.
- **One persistence gate,** consulted by every write path, metadata included (finding 2), and read at call time.
- **One file-creation helper** that always creates directories `0700` and files `0600` (finding 1). Both the synchronous and the queued writes use it.
- **Explicit types.** A discriminated union for the entries written, and a `TranscriptLine` type for the stamped message. No `any`.
- **The singleton stays a module-level instance** behind `getProject()`, with `resetProjectForTesting()` replacing it. It keeps `sessionFile`, `currentSessionWorktree` and a synchronous `reAppendCostState()` public.
- **Call-time reads.** Environment variables, bootstrap state (session id, cwd, prompt id, plan slug) and settings are read at call time, because the tests change them between calls.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.** The 70 inherited bodies were written anew. The writer's parts moved
  into `persistence/writer/`:
  - the line formatter and recording plan;
  - the metadata block;
  - the message remover;
  - the one helper that creates `0700` directories and `0600` files;
  - the remote mirror;
  - the persistence gate;
  - the last-prompt cleanup.

  `Project` gains `runInOrder`, `holdsEntry` and `adoptSessionFile`, and
  `recordTranscript` calls now run in order. The three characterization suites
  pass unchanged, and the on-disk fixtures still match byte for byte.
- **Fixes.** Findings 1, 2, 3, 6, 8 and 9 landed, each with a test.
  - Finding 2 honours `--no-session-persistence`, `cleanupPeriodDays: 0` and
    `CLAUDIN_SKIP_PROMPT_HISTORY`. It does not honour the `NODE_ENV=test` mute:
    `rename.characterization.test.ts` pins that `/rename` writes under plain
    test mode.
- **Probes.** `rewrite-sessions-persistence.json` holds 81 probes.
- **Residue.** 235 lines of Claude Code remain, in two kinds.
  - **Contract, about 120 lines.** The public signatures of the record and
    metadata families. The parameter shapes of
    `recordContextCollapseCommit` and `recordContextCollapseSnapshot`. The
    metadata fields of `Project` that callers read
    (`currentSessionTitle`, `currentSessionTag` and the others).
  - **To sweep, about 115 lines.** The brief kept every declaration outside
    the bodies, so the old private state of `Project` survived: the write queues,
    the flush timer and interval, the chunk limit, and the ingress and
    internal-event fields. So did the one-field-per-line mapping in
    `restoreSessionMetadata` and `clearSessionMetadata`. None of it is contract.
    A residue sweep rewrites it, with the class's private state stubbed along
    with its methods.
