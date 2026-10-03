# Spec: `sessions/resume`

The seven modules of this unit are `src/sessions/conversationRecovery.ts`,
`src/sessions/resume/chain.ts`, `resume/transcriptLoad.ts`,
`resume/subagents.ts`, `resume/cache.ts`, `src/sessions/sessionCandidates.ts`
and `src/sessions/crossProjectResume.ts`.

## Purpose

Turning a transcript on disk back into a conversation the CLI can continue:

- **Reading a transcript.** A session is a JSONL file under
  `<config home>/projects/<project directory>/<session id>.jsonl`. Reading one
  sorts its lines into conversation entries (keyed by uuid, in file order) and
  session metadata (title, tag, agent, mode, worktree, PR link, cost,
  snapshots, collapse state), and names the entries that end a branch, the
  *tips*.
- **Rebuilding one conversation.** From a tip, the `parentUuid` links are
  walked back to the root. What a single-parent walk would lose (sibling
  blocks of one streamed response, their tool results, the hook output and
  follow-up entries written around each tool call) is put back. Compactions
  that preserved a segment, and snips, are replayed first.
- **Making it ready to resume.** Legacy shapes are brought up to date,
  entries the API would reject are left out, a turn the previous process never
  finished is detected and handed back, the skill and attachment state the
  transcript already carries is restored, the resume SessionStart hooks run,
  and a conversation too large to resume safely is refused.
- **Around it.** Reading subagent transcripts back, a per-session memo of the
  recorded message uuids, the list of session files in a project directory,
  and the `cd … && … --resume <id>` command for a session from another
  directory.

`loadConversationForResume` is the one loader behind `--continue`,
`--resume <session id>`, `--resume <file.jsonl>`, the resume picker and the
headless resume. Most of the rest is reached through the session-storage
barrel `src/sessions/sessionStorage.ts`, which keeps every name it exports.

## Public contract

These keep their names, signatures and import paths: the modules not yet
rewritten import them. Names marked "(barrel)" are imported through
`src/sessions/sessionStorage.ts`.

### `conversationRecovery.ts`

| Export | Signature | Used by |
|---|---|---|
| `loadConversationForResume` | `(source: string \| LogOption \| undefined, sourceJsonlFile: string \| undefined) => Promise<LoadedResume \| null>`, where `LoadedResume` is `{ messages: Message[]; turnInterruptionState: TurnInterruptionState; fileHistorySnapshots?; attributionSnapshots?; contextCollapseCommits?; contextCollapseSnapshot?; sessionId: UUID \| undefined; agentName?; agentColor?; agentSetting?; customTitle?; tag?; mode?: 'coordinator' \| 'normal'; worktreeSession?: PersistedWorktreeSession \| null; prNumber?; prUrl?; prRepository?; costState: CostStateEntry \| undefined; fullPath?: string }`. `costState` is required (possibly undefined) so that a loader branch that forgets it fails to compile | `src/platform/main/defaultAction/continue.ts`, `resume.ts`, `src/platform/headless/print/sessionLoad.ts`, `src/sessions/ui/ResumeConversation.tsx`; its return type is named in `src/sessions/lifecycle/restore/types.ts` |
| `deserializeMessages` | `(serializedMessages: Message[]) => Message[]` | `src/agent/repl/REPL.tsx`, `src/agent/repl/resumeSession.ts`, `src/platform/teleport/teleport.tsx` |
| `deserializeMessagesWithInterruptDetection` | `(serializedMessages: Message[]) => DeserializeResult` | tests only |
| `restoreSkillStateFromMessages` | `(messages: Message[]) => void` | tests (`src/commands/clear/caches.ts` names it in a comment) |
| `loadMessagesFromJsonlPath` | `(path: string) => Promise<{ messages: SerializedMessage[]; sessionId: UUID \| undefined; costState: CostStateEntry \| undefined }>` | nobody (`knip-baseline.json` lists it) |
| `ResumeTranscriptTooLargeError` | `class extends Error { constructor(readonly bytes: number, readonly maxBytes: number, readonly messageCount: number) }` | thrown to every caller of `loadConversationForResume` |
| `TurnInterruptionState` (type) | `{ kind: 'none' } \| { kind: 'interrupted_prompt'; message: NormalizedUserMessage }` | `sessionLoad.ts`, `runHeadlessStreaming.ts` |
| `DeserializeResult` (type) | `{ messages: Message[]; turnInterruptionState: TurnInterruptionState }` | nobody by name |
| `TeleportRemoteResponse` (type) | `{ log: Message[]; branch?: string }` | `src/terminal/dialogLaunchers.tsx`, `src/sessions/hooks/useTeleportResume.tsx`, `src/platform/teleport/teleport.tsx`, `TeleportResumeWrapper.tsx` |

### `resume/chain.ts` (barrel)

| Export | Signature | Used by |
|---|---|---|
| `findLatestMessage` | `<T extends { timestamp: string }>(messages: Iterable<T>, predicate: (m: T) => boolean) => T \| undefined` | `src/sessions/indexing/liteMetadata.ts` (`getLastSessionLog`, `loadFullLog`, the lite loaders), `resume/subagents.ts` |
| `buildConversationChain` | `(messages: Map<UUID, TranscriptMessage>, leafMessage: TranscriptMessage) => TranscriptMessage[]` | `liteMetadata.ts`, `subagents.ts`, `conversationRecovery.ts` |
| `recoverOrphanedParallelToolResults` | `(messages: Map<UUID, TranscriptMessage>, chain: TranscriptMessage[], seen: Set<UUID>) => TranscriptMessage[]` | tests only |
| `applyPreservedSegmentRelinks` | `(messages: Map<UUID, TranscriptMessage>) => { relinkFailed: boolean }` | the barrel only |
| `applySnipRemovals` | `(messages: Map<UUID, TranscriptMessage>) => void` | the barrel only |

### `resume/transcriptLoad.ts`

| Export | Signature | Used by |
|---|---|---|
| `loadTranscriptFile` (barrel) | `(filePath: string, opts?: { keepAllLeaves?: boolean }) => Promise<LoadedTranscript>`, where `LoadedTranscript` is `{ messages: Map<UUID, TranscriptMessage>; summaries; customTitles; tags; agentNames; agentColors; agentSettings; prUrls; prRepositories; modes: Map<UUID, string>; prNumbers: Map<UUID, number>; worktreeStates: Map<UUID, PersistedWorktreeSession \| null>; costStates: Map<UUID, CostStateEntry>; fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>; attributionSnapshots: Map<UUID, AttributionSnapshotMessage>; contextCollapseCommits: ContextCollapseCommitEntry[]; contextCollapseSnapshot: ContextCollapseSnapshotEntry \| undefined; leafUuids: Set<UUID> }` (unlisted maps are `Map<UUID, string>`) | `liteMetadata.ts` (`keepAllLeaves: true` from `loadAllLogsFromSessionFile`), `subagents.ts`, `conversationRecovery.ts` |
| `loadSessionFile` | `(sessionId: UUID) => Promise<…>`: the same result without `agentNames`, `agentColors`, `prNumbers`, `prUrls`, `prRepositories`, `modes` and `leafUuids` in its type | `liteMetadata.ts`, `resume/cache.ts` |
| `buildFileHistorySnapshotChain` (barrel) | `(fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>, conversation: TranscriptMessage[]) => FileHistorySnapshot[]` | `liteMetadata.ts` |
| `buildAttributionSnapshotChain` (barrel) | `(attributionSnapshots: Map<UUID, AttributionSnapshotMessage>, _conversation: TranscriptMessage[]) => AttributionSnapshotMessage[]` | `liteMetadata.ts` |

### `resume/subagents.ts` (barrel)

| Export | Signature | Used by |
|---|---|---|
| `getAgentTranscript` | `(agentId: AgentId) => Promise<{ messages: Message[] } \| null>` | `src/tools/AgentTool/resumeAgent.ts`, `src/agent/summary/agentSummary.ts`, `REPL.tsx` |
| `loadSubagentTranscripts` | `(agentIds: string[]) => Promise<{ [agentId: string]: Message[] }>` | the barrel only |
| `loadAllSubagentTranscriptsFromDisk` | `() => Promise<{ [agentId: string]: Message[] }>` | the barrel only |
| `extractAgentIdsFromMessages` | `(messages: Message[]) => string[]` | the barrel only |
| `extractTeammateTranscriptsFromTasks` | `(tasks: { [taskId: string]: { type: string; identity?: { agentId: string }; messages?: Message[] } }) => { [agentId: string]: Message[] }` | the barrel only |

### `resume/cache.ts`

| Export | Signature | Used by |
|---|---|---|
| `getSessionMessages` | `((sessionId: UUID) => Promise<Set<UUID>>) & { cache: Map }`: a memoized function whose `.cache` callers read and prime (`cache.has(id)`, `cache.set(id, Promise<Set<UUID>>)`) | `src/sessions/persistence/record.ts` (dedup before writing), `persistence/project.ts`, `liteMetadata.ts` (primes it after a full read) |
| `clearSessionMessagesCache` (barrel) | `() => void` | `src/agent/compact/postCompactCleanup.ts`, tests and harnesses |
| `doesMessageExistInSession` (barrel) | `(sessionId: UUID, messageUuid: UUID) => Promise<boolean>` | `src/platform/headless/print/controlLoop.ts` |

### `sessionCandidates.ts`

| Export | Signature | Used by |
|---|---|---|
| `listCandidates` | `(projectDir: string, doStat: boolean, projectPath?: string) => Promise<Array<{ sessionId: string; filePath: string; mtime: number; projectPath?: string }>>` | `src/memory/autoDream/consolidationLock.ts` |

The module must stay importable without CLI initialisation: no bootstrap
state, no module-level mutable state.

### `crossProjectResume.ts`

| Export | Signature | Used by |
|---|---|---|
| `checkCrossProjectResume` | `(log: LogOption, showAllProjects: boolean, _worktreePaths: string[]) => CrossProjectResumeResult` | `src/commands/resume/resume.tsx`, `src/sessions/ui/ResumeConversation.tsx` |
| `CrossProjectResumeResult` (type) | `{ isCrossProject: false } \| { isCrossProject: true; isSameRepoWorktree: true; projectPath: string } \| { isCrossProject: true; isSameRepoWorktree: false; command: string; projectPath: string }` | the two callers, by shape |

## Observable behaviour

### 1. The transcript file: `loadTranscriptFile(filePath, opts)`

**The lines.** One JSON value per LF-terminated line. A line that does not
parse, or parses to something without a usable `type` (`null`, say), is
skipped and the rest loads. `recorded-session.jsonl` (written by the CLI's
persistence module) and `assorted-entries.jsonl` under
`src/sessions/resume/__fixtures__/rewrite/` are the pinned inputs.

**Conversation entries.** Lines whose `type` is `user`, `assistant`,
`attachment` or `system` go into `messages`, keyed by `uuid`, in file order (a
repeated uuid keeps its first position and its last content). Nothing else
does.

**Legacy progress entries.** A `progress` line with a string `uuid` is never a
message. A message whose `parentUuid` names one is re-parented to the nearest
non-progress ancestor, through any run of consecutive progress entries, or to
`null` when the run starts a chain. This works because parents precede
children in the file.

**Session metadata.** Each kind is keyed by the line's `sessionId` (ignored
when the line has none), and a later line overwrites an earlier one:

| `type` | Field read | Result map |
|---|---|---|
| `custom-title` | `customTitle` | `customTitles` |
| `tag` | `tag` | `tags` |
| `agent-name` | `agentName` | `agentNames` |
| `agent-color` | `agentColor` | `agentColors` |
| `agent-setting` | `agentSetting` | `agentSettings` |
| `mode` | `mode` | `modes` |
| `worktree-state` | `worktreeSession` (an object, or `null` for "exited") | `worktreeStates` |
| `pr-link` | `prNumber`, `prUrl`, `prRepository` | `prNumbers`, `prUrls`, `prRepositories` |
| `cost-state` | the whole line, when valid (below) | `costStates` |

Other kinds:
- `summary`: `summary`, keyed by `leafUuid` (ignored without one), into `summaries`.
- `file-history-snapshot`: the whole line, keyed by `messageId`, into `fileHistorySnapshots`.
- `attribution-snapshot`: the whole line, keyed by `messageId`, into `attributionSnapshots`.
- `marble-origami-commit`: appended to `contextCollapseCommits`, in file order.
- `marble-origami-snapshot`: `contextCollapseSnapshot`, the last one wins.
- A `system` entry with `subtype: 'compact_boundary'` empties `contextCollapseCommits` and clears `contextCollapseSnapshot` seen so far.
- Everything else is ignored, the file still loading: `ai-title`, `last-prompt`, `task-summary`, `queue-operation`, `speculation-accept`, the `content-replacement` lines an older build wrote, and unknown kinds.

**A `cost-state` line is validated.** It is kept only when all of these hold,
and otherwise skipped, so the last *valid* line wins and an invalid line alone
leaves no cost:
- `type` is `'cost-state'` and `sessionId` is a string;
- `totalCostUSD` is a number in `[0, 1e9]`;
- `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalLinesAdded`, `totalLinesRemoved`, `totalDuration` and `startTime` are non-negative numbers;
- `modelUsage` is an object whose keys are non-empty and hold no Unicode control (Cc) or format (Cf) character, and whose values have non-negative numbers `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`, `costUSD`;
- `hasUnknownModelCost`, when present, is a boolean.

The stored entry is the line as written (unknown extra fields may be dropped).

**Tool output saved to disk.** A tool result whose content was replaced by a
`<persisted-output>` preview has its raw `toolUseResult` removed before
parsing (the byte-level stripper of `sessions/storagePure`). Ordinary tool
results keep theirs.

**Replays, in this order, after reading:** the preserved-segment relink
(section 3) and the snip removals (section 4).

**Tips (`leafUuids`).** For every entry that no other entry names as its
parent, walk up its parents to the nearest `user` or `assistant` entry; that
entry is a tip. Entries with no such ancestor give none, and a parent loop
stops the walk without a tip. Sidechain entries count like any other. In a
small file, the last exchange before a plain compact boundary stays a tip,
because the boundary starts a new chain.

**Errors.** A file that cannot be read (missing, a directory) loads as an
empty transcript: every map empty, no tips. Nothing is thrown.

### 2. Transcripts over 5 MiB

When the file is larger than `SKIP_PRECOMPACT_THRESHOLD` (5 MiB, from
`sessions/storagePure`), and `CLAUDIN_DISABLE_PRECOMPACT_SKIP` is not truthy:

- **The cut.** Only the part from the last ordinary compact boundary on is read
  (storagePure's `readTranscriptForLoad`): entries before it are absent, and of
  the attribution snapshots only the last one after the cut survives.
- **Metadata before the cut is still read.** `summary`, `custom-title`, `tag`,
  `agent-name`, `agent-color`, `agent-setting`, `mode`, `worktree-state`,
  `cost-state` (validated) and `pr-link` lines before the cut are applied
  first; lines after the cut overwrite them.
- **Abandoned branches.** When what is left is still over 5 MiB, entries off
  the chain of the last main-thread entry are dropped before parsing, if they
  hold at least half the bytes (`walkChainBeforeParse`, from
  `sessions/indexingScan`). Metadata lines are always kept. This skip does not
  happen when the caller passes `keepAllLeaves: true`, or when the last
  boundary has a preserved segment (the segment is spliced in after parsing).
- **`CLAUDIN_DISABLE_PRECOMPACT_SKIP`** truthy loads everything: every entry,
  every branch, every attribution snapshot.

### 3. Compaction with a preserved segment: `applyPreservedSegmentRelinks(messages)`

A compact boundary may carry
`compactMetadata.preservedSegment: { headUuid, anchorUuid, tailUuid }`: the
run head→tail was kept by the compaction and should follow the anchor (the
summary). Working on the map in place:

- **No segment on any boundary:** nothing changes, plain boundaries included; `{ relinkFailed: false }`.
- **The segment is live** (it is on the last boundary of the file): the walk from the tail up to the head is checked first.
  - **When it holds and the anchor is in the map:** the head's parent becomes the anchor, and every other entry whose parent was the anchor now follows the tail. The `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` of every assistant entry in the segment become 0, its other usage fields kept.
  - **When it fails** (the tail is missing, a parent on the way is missing or `null` before the head, the walk loops, or the anchor is missing): nothing is relinked and `{ relinkFailed: true }`. A diagnostics event records the kind of failure; it is not pinned.
- **Stale:** a later boundary without a segment means no relink at all.
- **Pruning, in every case with a segment:** every entry before the last boundary is removed, except the segment's entries when the relink succeeded. The boundary itself stays.
- **Entries changed are replaced** by new objects in the map; the parsed objects are not mutated.

### 4. Snips: `applySnipRemovals(messages)`

Any entry may carry `snipMetadata.removedUuids`. All the listed uuids, across
all entries, are removed from the map. Each surviving entry whose parent was
removed is re-parented to the nearest ancestor that survives, following the
removed entries' own parent links. When that walk reaches a uuid missing from
the map, or the root, the parent becomes `null`. Untouched entries stay the
same objects.

### 5. One conversation: `buildConversationChain(messages, leaf)` and `findLatestMessage`

**`findLatestMessage(messages, predicate)`** returns the entry, among those
the predicate accepts, with the latest `timestamp` (parsed as a date). An entry
whose timestamp does not parse is never returned. Nothing accepted gives
`undefined`. Any iterable works. Ties: see Findings 1.

**The walk.** From `leaf`, follow `parentUuid` while the parent is in the map,
and return the entries root first, as the same objects. A missing parent
starts the chain after the gap. A loop stops at the first entry seen twice; an
error is logged, and each entry appears once.

**What a single-parent walk would lose comes back.** Streaming writes one
assistant entry per content block, all sharing the response's `message.id`.
For every response on the chain (an assistant entry with a non-empty
`message.id`):
- **its sibling blocks** that the walk skipped;
- **the tool results** whose parent is any of its blocks;
- **the hook output** (attachments with a `toolUseID`) naming any of its `tool_use` ids;
- **everything chained after one of those**, recursively.

All of them are inserted right after the last block of that response on the
chain: the skipped siblings first, then the rest, each group in file order,
never in timestamp order. Entries already on the chain are not repeated. A
response without `message.id` recovers nothing. An entry of an abandoned
branch is never pulled in by a response it does not belong to.
`recoverOrphanedParallelToolResults(messages, chain, seen)` does this on a
given walk (`seen` holds the uuids already on it), without touching the map.

### 6. Readying a conversation: `deserializeMessages` and `deserializeMessagesWithInterruptDetection`

Applied to the messages in order:

1. **Legacy attachments.**
   - `new_file` becomes `file`, and `new_directory` becomes `directory`, each with a `displayPath`.
   - Any attachment without `displayPath` gets one from `filename`, else `path`, else `skillDir`.
   - `displayPath` is the path relative to the current working directory (`getCwd()`). Attachments with a `displayPath` keep it.
2. **Renamed tools.** `tool_use` blocks with a legacy name get the current one; the id and input stay. `apply_patch` → `Patch`, `Task` → `Agent`, `KillShell` → `TaskStop`, `AgentOutputTool` and `BashOutputTool` → `TaskOutput`. The map is `normalizeLegacyToolName` in `src/permissions/permissionRuleParser.ts`. Inherited object members (`constructor`) are not names.
3. **Permission modes.** A user message whose `permissionMode` is not one this build knows gets `permissionMode: undefined`.
4. **Unanswered calls.** An assistant message all of whose `tool_use` blocks have no `tool_result` anywhere in the list is dropped. One with at least one answered call stays whole.
5. **Orphan thinking.** A thinking-only assistant message is dropped unless another assistant message with the same `message.id` carries other content.
6. **Thinking blocks and the provider.** When the active provider profile resolves to anything but first-party Anthropic, Bedrock, Vertex or Foundry (OpenAI-compatible, Gemini, Mistral, Copilot, Codex…), `thinking` and `redacted_thinking` blocks are removed from every assistant message. A message left empty is dropped. With no profile, the provider is first-party.
7. **Whitespace-only replies** are dropped (adjacent user messages are then merged by the message module).
8. **The unfinished turn.** The last message that is not `system`, not `progress`, not hook output (an attachment whose type starts with `hook_`, or `async_hook_response`) and not an API-error assistant message decides:

   | That message | `turnInterruptionState` |
   |---|---|
   | none, or an assistant message | `{ kind: 'none' }` |
   | a user message with `isMeta` or `isCompactSummary` | `{ kind: 'none' }` |
   | a plain user prompt | `{ kind: 'interrupted_prompt', message: <that prompt> }` |
   | a tool result, or any other attachment | a continuation is appended (below), and `{ kind: 'interrupted_prompt', message: <the continuation> }` |

   **The continuation** is a normalized user message with `isMeta: true`. It is
   the one line this module writes for the model: it must ask the model to
   continue the turn from where it stopped. The suite matches it as a meta user
   message mentioning "continue", not by its sentence.
9. **The answer placeholder.** When the last message that is not `system` or `progress` is a user message, an assistant message with the text `NO_RESPONSE_REQUESTED` (`src/agent/messages/constants.ts`) is inserted right after it, before any trailing system or progress messages. So the list ends API-valid, and a caller that removes the interrupted pair can splice two entries at the prompt's index.

`deserializeMessages` returns the same list without the report. A message that
cannot be read (an attachment message without `attachment`) makes the call
log the error and throw it.

### 7. State the transcript carries: `restoreSkillStateFromMessages(messages)`

For attachment messages only:
- **`invoked_skills`.** Each skill with a non-empty `name`, `path` and `content` is registered as invoked on the main thread (agent `null`, key `:<name>`). Incomplete entries are skipped.
- **`skill_listing`.** The next skill-listing injection is held back (`suppressNextSkillListing`).
- **`bash_git_instructions`.** The next git-instructions injection is held back, once (`suppressNextBashGitInstructions`). The agent that would have received it is marked as served, and the next agent still gets it.

### 8. The loader: `loadConversationForResume(source, sourceJsonlFile)`

**Which conversation:**

| Call | What is loaded | `sessionId` | Metadata |
|---|---|---|---|
| `source` undefined (`--continue`) | the most recent session of the project (`loadMessageLogs()[0]`), loaded in full; `sourceJsonlFile` is ignored | the log's | everything the log carries |
| `sourceJsonlFile` given, `source` defined | the file (section 9); `source` is ignored | the tip's session | only `costState` |
| `source` a string | `getLastSessionLog(source)` of `sessions/liteMetadata` | `source` | what that log carries: title, tag, agent setting, worktree, cost, snapshots, collapse state |
| `source` a `LogOption` | that log, loaded in full first when it is lite | the log's `sessionId`, else its first message's | everything the log carries |

**Nothing found** (no session to continue, no transcript for the id) gives
`null`.

**For a log** (not a path):
- **The plan.** The plan slug the log's messages carry (`slug`) is attached to the resumed session id, so the plan file follows the session.
- **File history** is copied for the resumed session, fire and forget (`copyFileHistoryForResume`).

**Then, in every case:**
1. The skill state is restored from the messages (section 7).
2. The messages are readied (section 6).
3. **The size check.** The readied messages are JSON-serialized and measured in UTF-8 bytes. Over 8 MiB (8 × 1024 × 1024) the load throws `ResumeTranscriptTooLargeError` before any hook runs.
4. **The hooks.** The SessionStart hooks run with source `'resume'` and the session id. Their messages are appended after the conversation.
5. **The size check again**, with the hook output included.

**The result** carries the readied messages (plus hook output), the
interruption state, and from the log:
- `fileHistorySnapshots`, `attributionSnapshots`, `contextCollapseCommits`, `contextCollapseSnapshot`;
- `agentName`, `agentColor`, `agentSetting`, `customTitle`, `tag`, `mode`, `worktreeSession`, `prNumber`, `prUrl`, `prRepository`;
- `costState`, the log's or else the path's;
- `fullPath`, the log's path to its transcript.

Errors are logged and rethrown.

**`ResumeTranscriptTooLargeError`.**
- **Fields.** `bytes`, `maxBytes` (8 MiB) and `messageCount`, and `name` is `'ResumeTranscriptTooLargeError'`.
- **Message.** It says the transcript is too large to resume, then `(<bytes in MiB, 1 decimal> MiB > <max in MiB, 1 decimal> MiB, <count> messages)`.

### 9. A transcript by path: `loadMessagesFromJsonlPath(path)`

The file is read as in section 1. The tip is the latest tip by timestamp
among the non-sidechain ones (timestamps that do not parse, or are not after
1970, never win). Its chain is built (section 5), and each message is returned
without `parentUuid` and `isSidechain` (`removeExtraFields`). Also returned are
the tip's `sessionId` (a fork copies its root from the source session, so the
tip is the one that names the session) and the cost of that session. With no
tip: `{ messages: [], sessionId: undefined, costState: undefined }`.

### 10. Subagent transcripts

**`getAgentTranscript(agentId)`** reads the file `getAgentTranscriptPath`
names: `<session's project dir>/<session id>/subagents/[<group>/]agent-<id>.jsonl`.
- **The tip.** Among the entries with that `agentId` and `isSidechain: true`, the latest entry that is no such entry's parent.
- **The chain.** Built from it over the whole file (section 5), then filtered to entries with that `agentId`.
- **The messages** are returned without `parentUuid` and `isSidechain`.
- **Null** when the file is missing or empty, or holds no such entry.

**`loadSubagentTranscripts(ids)`** maps each id to its messages, and leaves out
ids with nothing.

**`loadAllSubagentTranscriptsFromDisk()`** does the same for every regular file
`agent-<id>.jsonl` directly in the current session's `subagents/` directory.
Other names, directories and grouped agents are ignored. A missing directory
gives `{}`.

**`extractAgentIdsFromMessages(messages)`.**
- **Ids.** The string `data.agentId` of every `progress` message whose `data.type` is `agent_progress` or `skill_progress`.
- **Order.** Each id once, in first-seen order.

**`extractTeammateTranscriptsFromTasks(tasks)`.**
- **Which tasks.** `{ [identity.agentId]: messages }` for each task of type `in_process_teammate` with an agent id and at least one message.
- **The arrays** are the tasks' own.

### 11. Recorded uuids: `getSessionMessages`, `doesMessageExistInSession`, `clearSessionMessagesCache`

- **`getSessionMessages(id)`** is the set of entry uuids loaded (section 1) from
  `<dir>/<id>.jsonl`. `<dir>` is the current session's project directory when one is set (`switchSession(id, dir)`), else the original cwd's project directory.
- **Memoized per session id,** across the process. A file changed afterwards is not seen until `clearSessionMessagesCache()`. A missing file gives an empty set.
- **Shared.** Callers rely on the memo being one shared promise per id: the persistence module adds the uuids it writes to that set, and `getLastSessionLog` primes it after a full read.
- **`doesMessageExistInSession(id, uuid)`** asks that set.

### 12. Session files of a project: `listCandidates(dir, doStat, projectPath)`

- **Which entries.** One per directory entry named `<uuid>.jsonl`, uuid matched case-insensitively. Other names (`agent-*.jsonl`, other suffixes, short ids) are left out.
- **Each one** is `{ sessionId: <the name's uuid>, filePath: join(dir, name), mtime, projectPath }`.
- **`doStat` false:** `mtime` is 0 and entries are not checked: a directory or a dangling link with such a name is listed.
- **`doStat` true:** `mtime` is the modification time in ms, and entries that cannot be stat'ed are left out. A directory can be.
- **Errors.** An unreadable `dir` (missing, a file) gives `[]`.
- **Order** is not part of the contract.

### 13. Another directory: `checkCrossProjectResume(log, showAllProjects, worktreePaths)`

- **`{ isCrossProject: false }`** when `showAllProjects` is false, when the log has no `projectPath`, or when it equals the original cwd.
- **Otherwise** `{ isCrossProject: true, isSameRepoWorktree: false, projectPath, command }`:
  - **The command** is `cd <projectPath, shell-quoted> && <binary> --resume <session id>`. Run by a shell, the `cd` lands in exactly that directory, whatever its name holds.
  - **The session id** is the log's `sessionId`, or else its first message's.
- **`worktreePaths` is ignored:** a worktree of the same repository is another project (Findings 4).

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A transcript line that is not JSON, or is `null` | Skipped; the rest loads |
| A metadata line without `sessionId` (or a summary without `leafUuid`) | Ignored |
| An invalid `cost-state` after a valid one | The valid one stays |
| A parent loop in the chain | A partial chain, each entry once, an error logged |
| A parent loop below a terminal entry | No tip from it; the load does not hang |
| A preserved segment that cannot be walked | Only the boundary and what follows it load |
| A snip of an entry already absent | Its survivor becomes a root |
| `loadConversationForResume(undefined, path)` | The path is ignored: a `--continue` |
| A path to a missing file, or one with no tip | A result with no messages (only hook output), `sessionId` and `costState` undefined. Not `null`: the headless caller treats an empty result as "not found" |
| A conversation over 8 MiB | `ResumeTranscriptTooLargeError`; no SessionStart hook ran |
| Hook output that pushes the conversation over 8 MiB | `ResumeTranscriptTooLargeError` after the hooks ran. Not pinned: hook output is not large enough in practice to build a test on |
| An attachment message without `attachment` | `deserializeMessages` throws |
| A main-thread reply whose only child is a sidechain entry in the same file | It is not a tip, so a path resume takes an older branch. Not pinned: the CLI writes sidechains to their own files |
| A grouped subagent (under `subagents/<group>/`) | Found by `getAgentTranscript`, missed by the disk scan |
| Messages tied on the latest timestamp | Findings 1 |
| A log whose `sessionId` and first message both lack an id | The command ends `--resume undefined`. Not pinned |

## Security requirements

**Pinned by the tests:**
- **A `cost-state` line from disk is validated** before it can be restored: no negative or absurd (> 1e9) cost, no negative counter, and no model name with control or format characters, since `/cost` prints those names on a terminal.
- **The cross-project command shell-quotes the directory.** A user pastes it, so a directory name with quotes, `;`, `$(…)` or `&&` must not run anything. The suite runs the `cd` part in a real bash against such a name.
- **A permission mode read from disk is validated.** An unknown mode never reaches the session.
- **The 8 MiB resume cap** is checked before the resume hooks run.
- **Raw output of tool results saved to disk** is not loaded back into memory.

**Kept, but not pinned:**
- **The session id in the cross-project command is not quoted.** For listed sessions it is a validated uuid (the file name). Only the fallback to the first message's `sessionId` reads unvalidated transcript text. See Findings 5.
- **Subagent ids from the disk scan** come from directory entry names, so they cannot hold a path separator.

## Tests that pin it

- **The suites.** 162 tests in six files, green in 3 runs in a row:

  | Suite | What it pins |
  |---|---|
  | `src/sessions/resume/resume.chain.characterization.test.ts` | `findLatestMessage`, the walk, the recovery of skipped blocks, results, hook output and follow-ups, preserved segments, snips (sections 3–5) |
  | `src/sessions/resume/resume.transcriptLoad.characterization.test.ts` | the line kinds, metadata maps, cost validation, legacy progress, collapse state, tips, transcripts over 5 MiB, file-history chains (sections 1–2) |
  | `src/sessions/resume/resume.subagents.characterization.test.ts` | subagent transcripts, written through `recordSidechainTranscript` and by hand, and the recorded-uuid memo (sections 10–11) |
  | `src/sessions/conversationRecovery.characterization.test.ts` | readying a conversation, the provider table, legacy shapes, the restored state (sections 6–7) |
  | `src/sessions/conversationRecovery.load.characterization.test.ts` | the loader for each source, hooks, the size cap, the plan, path resumes (sections 8–9) |
  | `src/sessions/resumeLookup.characterization.test.ts` | `listCandidates` and `checkCrossProjectResume` (sections 12–13) |

- **Line coverage of the old modules:** 100% for every file but `resume/subagents.ts`, which has 97.2%: its two unreached lines handle failures that reading a transcript cannot produce.
- **The fixtures**, under `src/sessions/resume/__fixtures__/rewrite/`:
  - `recorded-session.jsonl`, a session recorded by the persistence module, with its ids made readable;
  - `assorted-entries.jsonl`, every other kind of line: legacy progress, collapse entries around a boundary, attribution snapshots, a summary, ignored kinds, a bad line, `null`, and a terminal hook attachment.
  - The suites also read storagePure's `src/sessions/__fixtures__/rewrite/persisted-output.input.jsonl`.
- **The harnesses.**
  - `src/sessions/__testutils__/resumeTranscripts.ts` builds lines laid out as the CLI writes them (`parentUuid` first, `uuid` right before `timestamp`), which the byte scans of large files need.
  - The suites that need a world use `useRestoreSandbox`/`writeSession` from `src/sessions/__testutils__/restoreHarness.ts`.
- **How the tests reach the runtime inputs.** The rewrite has to respect these:
  - **Every path** is under a temp dir, with `CLAUDIN_CONFIG_DIR` and the original cwd pointing there.
  - **The provider** is chosen through a provider profile in the in-memory test global config, so thinking-block stripping must read the active profile at call time.
  - **SessionStart hooks** are real command hooks in a temp `settings.json`.
  - **The skill-listing hold** is read through `_getSkillLatchSnapshotForTests`. The git-instructions hold is observed through `getBashGitInstructionsAttachment` under `NODE_ENV=production`.
  - **`CLAUDIN_DISABLE_PRECOMPACT_SKIP`** is read at call time.
- **The probes.** `scripts/migrations/probes/rewrite-sessions-resume.json` holds 40 probes:
  - 10 on `conversationRecovery.ts`, 11 on `resume/chain.ts` and 10 on `resume/transcriptLoad.ts`;
  - 4 on `resume/subagents.ts`, 2 each on `resume/cache.ts` and `sessionCandidates.ts`, and 1 on `crossProjectResume.ts`.

  Every one turns the suites red.
- **This project's own tests stay.** They exercise the unit through its contract:
  - `src/sessions/resume/chain.test.ts`: parallel results in write order;
  - `src/sessions/conversationRecovery.test.ts`: its own three cases (the Stop hook, the git-instructions hold, the renamed patch tool);
  - `src/sessions/__tests__/resumeRoundTrip.test.ts`, `project.test.ts`, `src/sessions/resumePrefixDeterminism.test.ts`, `sessionRestore.costState.test.ts`, `sessionLifecycle.characterization.test.ts`;
  - `src/platform/main/defaultAction/resume.characterization.test.tsx`, `src/platform/headless/print/sessionLoad.characterization.test.ts`.
- **The inherited tests.**
  - **`conversationRecovery.test.ts`.** Its inherited cases were deleted: the small and the oversized path resume, their helpers, and the hook-after-tool-result case, whose two lines matched. All three are covered in the suites above.
  - **`conversationRecovery.hooks.test.ts` and `sessionStorage.test.ts`** do not exist at the characterized commit (`6e89dbbb`), so there was nothing to fold.
- **Files outside the unit that pin the continuation prompt byte for byte:** none. `src/sessions/pure/firstPrompt.test.ts` builds a message with the same sentence as its own input; it does not read this module's output.
- **Not pinned, and why:**
  - **The wording of the continuation prompt:** the rewrite writes its own (its facts are pinned).
  - **The diagnostics events of a failed relink**, and the error log of a chain loop: they go to logs only.
  - **The second size check** (after hooks): no hook output in a test is large enough.
  - **What the Findings marked "fix" would change.**
  - **The rows marked "Not pinned" above.**

## Out of scope

- **Unused exports.** Nothing imports them outside the barrel and tests:
  - `loadMessagesFromJsonlPath` (in `knip-baseline.json`). Its behaviour is pinned through `loadConversationForResume`.
  - `loadSubagentTranscripts`, `loadAllSubagentTranscriptsFromDisk`, `extractAgentIdsFromMessages`, `extractTeammateTranscriptsFromTasks`.
  - `recoverOrphanedParallelToolResults`, `applyPreservedSegmentRelinks` and `applySnipRemovals` as separate exports: their behaviour is part of `buildConversationChain` and `loadTranscriptFile`.
  - `deserializeMessagesWithInterruptDetection` and `restoreSkillStateFromMessages` have no production importer. `loadConversationForResume` is their consumer.
  - The `DeserializeResult` type.

  Keep the barrel names until their importers are rewritten, or drop the export and refresh the knip baseline in the same change.
- **`buildAttributionSnapshotChain`'s second parameter** is unused. It returns every snapshot in map order.
- **The `marble-origami-*` entry names** are on-disk names and stay. The context-collapse feature itself is folded out of this build.

## Findings

The old modules had each of these. None is fixed in the characterization: the
suite passes on the old code. What a "fix" would change is left unpinned.

1. **On a timestamp tie, the first entry wins.**
   - **Where.** `findLatestMessage` keeps the first of several entries sharing the latest timestamp. A path resume picks its tip the same way among tips.
   - **The effect.** The CLI routinely writes several messages in the same millisecond (consecutive assistant blocks, a reply and the next). `--resume <session-id>` goes through `getLastSessionLog`, which asks for the latest non-sidechain entry. On a tie it takes the earliest of them and rebuilds the chain from there, so the later replies are dropped. `--continue` and resuming by title go through the tips and keep them.
   - **The pin.** `src/platform/main/defaultAction/resume.characterization.test.tsx` holds the defect ("messages with tied timestamps, resumed by session id": two texts and the answer placeholder).
   - **Decision: fix.** On a tie, the entry later in iteration order wins; for a transcript map that is file order, the order the CLI wrote them. Apply the same rule to the path resume's tip. It is a read-time choice: no stored data, configuration or workflow depends on losing replies.
   - **What the fix changes.** The `resume.characterization.test.tsx` row must then expect `['Let us fix the parser.', 'On it.', 'That is all for now.']`. `getAgentTranscript` and `loadFullLog` benefit the same way.
2. **The cross-project command runs `claude`, not `claudin`.**
   - **The effect.** The command copied to the clipboard and shown by `/resume` and the picker launches another product's binary. The resume hint at exit (`src/shared/proc/gracefulShutdown.ts`) and the tips already say `claudin --resume`.
   - **Decision: fix.** Nothing stores the command. The suite pins its shape with any binary name.
3. **Messages handed to `deserializeMessages` are mutated.** An unknown `permissionMode` is cleared on the caller's own message object, not on a copy. **Decision: fix.** Every caller passes messages it has just loaded and does not reuse. Clear the field on the returned copy. Not pinned.
4. **`worktreePaths` is ignored, and `isSameRepoWorktree: true` is never returned.**
   - **The effect.** Both callers have a branch that resumes a same-repository worktree in place, and it is dead. A session from a sibling worktree always gets a `cd` command.
   - **Decision: keep for parity** (pinned). Resuming a session from another worktree in the current directory changes which files the conversation's paths point at. Whether to do that is a product decision. Track it.
5. **The session id in the cross-project command is not shell-quoted.** It comes from the log's `sessionId`, a uuid validated from the file name, or else from the first message's `sessionId`, read unvalidated from the transcript. **Decision: fix, as pure hardening.** Quote it like the directory. A uuid quotes to itself, so legitimate use never notices.
6. **A path that names nothing still loads.** `--resume <missing.jsonl>` gives a result with no messages instead of `null`.
   - **Who relies on it.** The headless caller treats an empty result as not found, except for URL and CCR v2 resumes, which rely on getting an empty result for a freshly hydrated, empty transcript.
   - **The gap.** A SessionStart `resume` hook that prints output makes the result non-empty, and the session then starts with hook output only.
   - **Decision: keep for parity** (the empty result is pinned). Track making a missing file an explicit error once the CCR v2 caller no longer needs the empty case.
7. **`loadConversationForResume(undefined, path)` ignores the path** and continues the latest session. **Decision: keep for parity** (pinned). Every caller that passes a path also passes a session id.
8. **The disk scan of subagent transcripts misses grouped agents** (`subagents/<group>/agent-<id>.jsonl`), which `getAgentTranscript` reads. **Decision: keep for parity** (pinned). The scan has no importer outside the barrel.
9. **`listCandidates` without stat lists any entry with a session-like name**, a directory or a dangling link included. With stat, a directory is still listed. **Decision: keep for parity** (pinned). Its one caller counts sessions for a skip gate, where an overcount is harmless.

## Target design

- **Slice layout.** Keep the files where callers import them, and keep `src/sessions/sessionStorage.ts` re-exporting the same names. Under `src/sessions/resume/`:
  - **`transcriptFile`**: reading a file into a typed `LoadedTranscript`. One table maps each metadata kind to its field and result map, so the small-file and pre-cut paths share it rather than repeating it.
  - **`costStateSchema`**: the validation of section 1, as a schema with a named type.
  - **`compactionReplay`**: the preserved-segment relink and the snip replay, each a pure function over the map returning what it changed.
  - **`conversationChain`**: the walk and the recovery of skipped entries.
  - **`latest`**: one tie rule (Findings 1), shared by every "latest" choice in the unit.
- **`conversationRecovery.ts`** splits into three parts:
  - **readying**: a pipeline of small named steps over messages (legacy migrations, filters, the provider decision, interruption detection, the placeholder). Each step returns new messages and never mutates its input (Findings 3);
  - **restoring** process state from attachments;
  - **the loader**: source selection as a discriminated union (`continue`, `sessionId`, `log`, `file`), then one shared tail (restore, ready, size check, hooks, size check).
- **Types to make explicit:**
  - `TipChoice`: the latest entry by timestamp, ties to the later one;
  - `ResumeSource`;
  - `LoadedResume`, the loader's result (today an anonymous type that `lifecycle/restore/types.ts` reaches for with `ReturnType`).
- **`crossProjectResume`** builds its command from the binary name the rest of the CLI uses, and quotes every argument.
- **Follow `.claudin/rules/code-design.md`:** no module-level mutable state except the uuid memo, which stays one shared memo per session id because the persistence module adds to it.
