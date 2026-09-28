# Spec: `sessions/storagePure`

## Purpose

The side-effect-light half of session storage. A session is a JSONL transcript
under `<config home>/projects/<project directory>/`, and this unit answers the
questions every other part of session storage asks about it:

- **Where it lives.** The project directory for a cwd, the transcript of the current session, and the transcripts of other sessions and of subagents.
- **What gets written.** Which entries are transcript messages or join the `parentUuid` chain, and what a message looks like when it is logged.
- **What a session is called.** The title the resume picker shows, read from parsed messages or from the raw head of a file.
- **How big files are read cheaply.** Single fields without parsing a line, the head and tail of a file, and the tail of a large transcript from its last compact boundary on.
- **How raw tool results leave a resume.** A tool result replaced by a `<persisted-output>` preview still has its raw form on the same line, and resume cuts it out of the bytes before anything is parsed.

Transcripts are files users keep across versions, so every rule about bytes on
disk below is a compatibility rule.

The unit is six files. Five sit under `src/sessions/pure/`, and most of their
names reach callers through the session-storage barrel
(`src/sessions/sessionStorage.ts`). `src/sessions/sessionStoragePortable.ts` is
imported directly.

## Public contract

These keep their names and types, because the modules not yet rewritten import
them. The barrel must keep re-exporting every name it exports today:
`src/sessions/__tests__/barrelExports.test.ts` pins the list with a snapshot.

**Through the barrel** (`src/sessions/sessionStorage.ts`):

| Export | Signature | Used by |
|---|---|---|
| `isTranscriptMessage` | `(entry: Entry) => entry is TranscriptMessage` | `commands/branch/branch.ts`, `platform/stats.ts`, `platform/teleport/teleport.tsx`; directly by `sessions/persistence/project.ts`, `sessions/resume/transcriptLoad.ts` |
| `isChainParticipant` | `(m: Pick<Message, 'type'>) => boolean` | `agent/hooks/useLogMessages.ts`; directly by `sessions/persistence/record.ts`, `sessions/persistence/project.ts` |
| `isLegacyProgressEntry` | `(entry: unknown) => entry is LegacyProgressEntry` | directly by `sessions/resume/transcriptLoad.ts` |
| `LegacyProgressEntry` (type) | `{ type: 'progress'; uuid: UUID; parentUuid: UUID \| null }` | the guard above |
| `EPHEMERAL_PROGRESS_TYPES` | `Set<string>` | nothing outside the unit; kept for the barrel |
| `isEphemeralToolProgress` | `(dataType: unknown) => boolean` | `agent/repl/controllers/useOnQuery.ts` |
| `getProjectsDir` | `() => string` | `platform/stats.ts`, `platform/cleanup.ts`; directly by `platform/usageContribution/usageContribution.ts`, `sessions/indexing/crossProject.ts`, `skills/bundled/fewerPermissionPrompts.ts` |
| `getProjectDir` | `(projectDir: string) => string`, memoized, with `cache.clear()` | `agent/tools/toolResultStorage.ts`, `commands/branch/branch.ts`, `commands/dream/dream.ts`, the three `memory/autoDream/` modules, `memory/memdir/memdir.ts`, `memory/session/paths.ts`, `permissions/filePermissions/internalPaths.ts`; directly by six `sessions/` modules and `skills/bundled/refreshRules.ts` |
| `getTranscriptPath` | `() => string` | `agent/compact/compact.ts`, `agent/compact/sessionMemoryCompact.ts`, `commands/{branch,color,rename}`, `permissions/ui/ExitPlanModePermissionRequest`, `platform/lifecycleHooks/execAgentHook.ts`, `terminal/prompt-suggestion/speculation.ts`; directly by `sessions/indexing/liteMetadata.ts`, `sessions/persistence/{record,project}.ts` |
| `getTranscriptPathForSession` | `(sessionId: string) => string` | `commands/branch/branch.ts`, `platform/lifecycleHooks/shared.ts`; directly by `liteMetadata.ts`, `persistence/{project,metadata}.ts` |
| `getAgentTranscriptPath` | `(agentId: AgentId) => string` | `agent/tasks/LocalMainSessionTask.ts`, `agent/tasks/LocalAgentTask/LocalAgentTask.tsx`, `commands/clear/conversation.ts`, `platform/lifecycleHooks/{replHooks,execAgentHook}.ts`; directly by `sessions/indexing/agents.ts`, `persistence/project.ts`, `resume/subagents.ts` |
| `setAgentTranscriptSubdir` | `(agentId: string, subdir: string) => void` | `tools/AgentTool/runAgent.ts` |
| `clearAgentTranscriptSubdir` | `(agentId: string) => void` | `tools/AgentTool/runAgent.ts` |
| `MAX_TRANSCRIPT_READ_BYTES` | `number` | directly by `platform/usageContribution/usageContribution.ts` |
| `extractFirstPrompt` | `(transcript: TranscriptMessage[]) => string` | directly by `sessions/indexing/liteMetadata.ts` |
| `extractFirstPromptFromChunk` | `(chunk: string) => string` | directly by `sessions/indexing/liteMetadata.ts` |
| `getFirstMeaningfulUserMessageTextContent` | `<T extends Message>(transcript: T[]) => string \| undefined` | directly by `sessions/persistence/project.ts` |
| `SKIP_FIRST_PROMPT_PATTERN` | `RegExp` | nothing outside the unit; kept for the barrel |
| `getUserType` | `() => string` | directly by `sessions/persistence/project.ts` |
| `removeExtraFields` | `(transcript: TranscriptMessage[]) => SerializedMessage[]` | `sessions/conversationRecovery.ts`; directly by `liteMetadata.ts` |
| `isLoggableMessage` | `(m: Message) => boolean` | `agent/repl/REPL.tsx`, `agent/repl/controllers/useOnQuery.ts` |
| `cleanMessagesForLogging` | `(messages: Message[], allMessages?: readonly Message[]) => (UserMessage \| AssistantMessage \| AttachmentMessage \| SystemMessage)[]` | `agent/hooks/useLogMessages.ts`; directly by `sessions/persistence/record.ts` |
| `stripPersistedToolUseResultsFromJSONLBuffer` | `(buf: Buffer) => Buffer` | directly by `sessions/resume/transcriptLoad.ts` |

**Straight from `src/sessions/pure/jsonlStripping.ts`:**

| Export | Signature | Used by |
|---|---|---|
| `forEachParsedJSONLBufferEntry` | `<T>(buf: Buffer, visit: (entry: T) => void) => void` | `sessions/resume/transcriptLoad.ts` |

**Straight from `src/sessions/sessionStoragePortable.ts`:**

| Export | Signature | Used by |
|---|---|---|
| `LITE_READ_BUF_SIZE` | `number` (65536) | `sessions/indexing/liteMetadata.ts`, `sessions/persistence/{project,_helpers}.ts` |
| `validateUuid` | `(maybeUuid: unknown) => UUID \| null` | `sessions/sessionCandidates.ts` |
| `extractJsonStringField` | `(text: string, key: string) => string \| undefined` | `liteMetadata.ts` |
| `extractLastJsonStringField` | `(text: string, key: string) => string \| undefined` | `liteMetadata.ts`, `persistence/project.ts` |
| `readHeadAndTail` | `(filePath: string, fileSize: number, buf: Buffer) => Promise<{ head: string; tail: string }>` | `liteMetadata.ts` |
| `sanitizePath` | `(name: string) => string` | `platform/bridge/bridgePointer.ts`, `scripts/bench/tokens/measure-explore-redundancy.ts`, and through the re-export in `src/shared/fs/path.ts`: `memory/memdir/paths.ts`, `platform/tmpdir.ts`, `sessions/indexing/crossProject.ts`, `sessions/pure/paths.ts`, `tools/AgentTool/agentMemory.ts` |
| `getProjectsDir` | `() => string` | `platform/bridge/bridgePointer.ts` |
| `getProjectDir` | `(projectDir: string) => string`, not memoized | `commands/auto-mode-setup/collectSignals.ts`, `sessions/rerootSession.ts` |
| `SKIP_PRECOMPACT_THRESHOLD` | `number` (5 MiB) | `sessions/resume/transcriptLoad.ts` |
| `readTranscriptForLoad` | `(filePath: string, fileSize: number) => Promise<{ boundaryStartOffset: number; postBoundaryBuf: Buffer; hasPreservedSegment: boolean }>` | `sessions/resume/transcriptLoad.ts` |

**Structure constraints:**
- `sessionStoragePortable.ts` must not import the barrel or anything that needs the app's bootstrap state. The bridge and the lite-metadata reader load it on their own, and the suite bundles it alone to run it under Node.
- `src/shared/fs/path.ts` keeps re-exporting `sanitizePath`.
- The barrel's `getProjectDir` must keep a callable `getProjectDir.cache.clear()`. Five test files call it: `src/agent/toolResultCodeOutline.test.ts` and four under `src/sessions/__tests__/`.
- Eight more exports exist that nothing imports. See Out of scope.

## Observable behaviour

### 1. Transcript entries

- **`isTranscriptMessage(entry)`** is true for the four message types `user`, `assistant`, `attachment` and `system`, and false for everything else: `progress`, every metadata entry (`summary`, `custom-title`, `ai-title`, `last-prompt`, `task-summary`, `tag`, `agent-name`, `agent-color`, `agent-setting`, `pr-link`, `mode`, `worktree-state`, `cost-state`, `file-history-snapshot`, `attribution-snapshot`, `queue-operation`, `speculation-accept`, `marble-origami-commit`, `marble-origami-snapshot`) and unknown types. Only `type` is read.
- **`isChainParticipant(m)`** is false for `progress` and true for any other type.
- **`isLegacyProgressEntry(value)`** is true for a non-null object whose `type` is `'progress'` and whose `uuid` is a string. `parentUuid` is not required. It is false for null, undefined, strings, arrays and a non-string `uuid`.
- **`EPHEMERAL_PROGRESS_TYPES`** is a `Set` of exactly `bash_progress`, `powershell_progress`, `mcp_progress`, `build_progress`, `test_progress` and `check_progress`: tool ticks of which only the last is ever shown.
- **`isEphemeralToolProgress(value)`** is true only for a string in that set, compared case-sensitively and without trimming.

### 2. What a transcript keeps

- **`getUserType()`** returns `'external'`, always.
- **`removeExtraFields(transcript)`** returns a new array of new objects: each is the entry without `parentUuid` and `isSidechain`, with every other member kept (`logicalParentUuid` included). The order and length are the same, and the input objects are not modified.
- **`isLoggableMessage(m)`:**
  - a `progress` message is never written;
  - an `attachment` is written exactly when `shouldPersistAttachment(m.attachment.type)` says so (the table in `src/sessions/pure/attachmentPersistence.ts`), which is false for a type the table does not know;
  - every other message is written.
- **`cleanMessagesForLogging(messages, allMessages?)`** returns the loggable messages in their order, with two changes:
  - a user or assistant message whose `message.content` is an empty list is dropped (an empty string is not);
  - a message with `isVirtual: true` comes out as a copy without the `isVirtual` member, whatever its type. The input message keeps its flag.

  Everything else passes through as it is. The second argument has no effect.

### 3. Session titles

**`SKIP_FIRST_PROMPT_PATTERN`** is a `RegExp` without the global or sticky flag,
so repeated `test` calls agree. It matches text that is not a prompt:
- **Tagged output.** Optional leading whitespace, then `<`, a lowercase ASCII letter, any letters, digits, `_` or `-`, then whitespace or `>`: `<ide_selection>…`, `  <local-command-stdout>`, `<x` followed by a newline.
- **Interruption markers.** Text that starts, with no leading whitespace, with `[Request interrupted by user`, any characters other than `]`, and a closing `]`.
- **What it does not match.** An uppercase tag (`<Div>`), `<3`, `<br/>`, `<>`, a marker after a space, and ordinary text.

**The tags** are `<command-name>`, `<command-args>` and `<bash-input>`. They are
read with `extractTag` (`src/agent/messages/text.ts`), where a tag with empty
content counts as absent. The built-in command names are
`builtInCommandNames()` from `src/commands/commands.ts`, aliases included.

**`getFirstMeaningfulUserMessageTextContent(messages)`** returns the first
meaningful text, verbatim (not trimmed, newlines kept), or `undefined`.
- **Candidate messages.** Messages of type `user` that are not `isMeta`, not `isCompactSummary`, and have content.
- **Candidate texts, in order.** String content, or the non-empty `text` of each `text` block of list content. Other blocks (tool results, images) are ignored, so a prompt placed after IDE context blocks is found.
- **The rules, applied to each text in this precedence:**
  1. **Commands.** A text with a `command-name` tag is a command. The command is named by the tag content without a leading `/`.
     - A built-in command is skipped.
     - A custom command whose `command-args` content, trimmed, is empty is skipped.
     - Otherwise the result is `<tag content> <trimmed args>`, for example `/deploy-docs staging --force`.
  2. **Bash input.** A non-empty `bash-input` tag gives `! <content>`, even though the text opens with a tag.
  3. **Skipped text.** A text matched by `SKIP_FIRST_PROMPT_PATTERN` is skipped.
  4. **Anything else** is the result.

**`extractFirstPrompt(transcript)`** is the title of the text above:
- **Flattening.** Every LF becomes a space, and the result is trimmed.
- **Length.** Up to 200 characters are kept as they are. A longer title is cut to 200 characters, trimmed again, and ends in `…` (U+2026).
- **No prompt.** With no meaningful text it returns `No prompt`.

**`extractFirstPromptFromChunk(chunk)`** reads the same kind of title from raw
JSONL text, typically the first 64 KiB of a file, whose last line may be cut.
Each LF-separated line is considered only when:
- **its raw text contains** `"type":"user"` or `"type": "user"`;
- **its raw text does not contain** `"tool_result"`, `"isMeta":true` or `"isMeta": true`, anywhere on the line;
- **it parses as JSON**, with `type` `'user'` and a `message` member. A line that does not parse is skipped.

Its texts are chosen as above, except that non-string `text` values are ignored.
- **Flattening first.** Every text is flattened and trimmed before any rule applies, so a marker after leading spaces is recognised here.
- **The command fallback.** A built-in command, and a custom command without arguments, record the first such tag content (`/model`) as a fallback and are skipped.
- **The other rules.** A custom command with arguments gives `<tag content> <args>`, bash input gives `! <flattened content>`, and skipped text is skipped. The first remaining text is the result, cut like `extractFirstPrompt`.
- **Nothing found.** The result is the fallback, and otherwise `''`.
- **Line endings.** CRLF lines are read like LF lines.

### 4. Where transcripts live

- **`getProjectsDir()`** (both exports) is `join(getClaudinConfigHomeDir(), 'projects')`: `CLAUDIN_CONFIG_DIR` or `~/.claudin`, read at every call.
- **`getProjectDir(cwd)`** (both exports) is `join(getProjectsDir(), sanitizePath(cwd))`.
  - The portable one computes it at every call.
  - The barrel one is memoized per cwd and exposes `cache.clear()`. See finding 8 for what the memo must be keyed on.
- **`getTranscriptPath()`** is `<dir>/<getSessionId()>.jsonl`. `<dir>` is `getSessionProjectDir()` when the session was switched in with a project directory, and otherwise `getProjectDir(getOriginalCwd())`. All three are read at call time.
- **`getTranscriptPathForSession(id)`:**
  - for the current session id, the same as `getTranscriptPath()`;
  - for any other id, `<getProjectDir(getOriginalCwd())>/<id>.jsonl`, ignoring the session project directory, because other sessions' directories are not tracked.
- **`getAgentTranscriptPath(agentId)`** is `<dir>/<sessionId>/subagents/[<subdir>/]agent-<agentId>.jsonl`, with the same `<dir>` as `getTranscriptPath()`.
  - **`<subdir>`** is the value last given to `setAgentTranscriptSubdir` for that agent. It may contain `/`, which nests it (`workflows/run-7`).
  - **An empty subdir** is the same as none.
  - **`clearAgentTranscriptSubdir`** removes it. Each agent has its own entry.
- **`MAX_TRANSCRIPT_READ_BYTES`** is 50 MiB (52,428,800): the cap for callers that read a whole transcript.

### 5. Project directory names: `sanitizePath(name)`

- **The characters.** Every UTF-16 code unit that is not `A`–`Z`, `a`–`z` or `0`–`9` becomes `-`, so `é` gives one dash and an emoji two.
  - `/Users/dev/my-project` becomes `-Users-dev-my-project`, and `C:\Users\dev\acme` becomes `C--Users-dev-acme`.
  - The empty string stays empty.
- **Up to 200 characters,** the sanitized text is the name.
- **A longer name** is the first 200 characters of the sanitized text, `-`, and a suffix: the base-36 form of the absolute value of `djb2Hash(name)` (`src/shared/data/hash.ts`), taken over the original name, not the sanitized one.
  - `/` followed by 250 `a` ends in `-feo44x`.
  - `/work/` followed by forty `nested/` and `app` ends in `-4trpsi`.
  - Two long names that sanitize alike still differ in their suffix.
- **Under Bun the suffix is different:** the base-36 form of `Bun.hash(name)`, over the original name as well. The same two names end in `-lni537xdrusg` and `-3dh8vz4brrq16`. Both suffixes stay, see finding 1.
- **`MAX_SANITIZED_LENGTH`** (200) is exported but not imported by anyone.

### 6. Reading fields without parsing

- **`validateUuid(value)`** returns `value` itself when it is a string of exactly 8-4-4-4-12 hexadecimal digits, in any case. No version or variant check is made, so the nil UUID passes. Anything else, including surrounding whitespace, a trailing newline and non-strings, gives `null`.
- **`extractJsonStringField(text, key)`** finds a string member in raw text without parsing it.
  - **The two forms.** It looks for `"<key>":"` (compact) and `"<key>": "` (one space).
  - **The key is matched with its quotes,** so `id` does not match `uuid`. Nested members count.
  - **The value** runs to the next unescaped `"`, where a backslash escapes the character after it. It is returned decoded by JSON string rules, or verbatim when its escapes are invalid (`bad \x escape`).
  - **An occurrence with no closing quote** does not count. A text cut short in the compact form still finds a complete spaced one.
  - **The result** is `undefined` when there is no complete occurrence, and when the member is not a string.
- **`extractLastJsonStringField(text, key)`** works the same way and returns the last complete occurrence. A last occurrence cut short falls back to the one before it.

### 7. Head and tail: `readHeadAndTail(filePath, fileSize, buf)`

- **The buffer.** The caller passes one buffer of at least `LITE_READ_BUF_SIZE` (64 KiB) bytes and reuses it across files. Both strings stay correct although they are read through the same buffer.
- **`head`** is the UTF-8 decoding of the first 64 KiB, or of the whole file when it is shorter.
- **`tail`:**
  - when `fileSize` is at most 64 KiB, it equals `head`;
  - otherwise it is the decoding of up to 64 KiB read from offset `fileSize - 64 KiB`. That offset uses the size the caller passed, not the file's own.
- **Cut characters.** A multi-byte character cut at either edge decodes to U+FFFD.
- **Errors.** It never rejects. An empty file, a missing path, a directory, or a buffer shorter than 64 KiB all give `{ head: '', tail: '' }`.

### 8. Stripping persisted raw results: `stripPersistedToolUseResultsFromJSONLBuffer(buf)`

**The on-disk facts it relies on.** A transcript line is one JSON object
followed by LF. When a tool result is too large, its `tool_result` content
becomes a preview wrapped in `<persisted-output>` … `</persisted-output>`, made by
`buildLargeToolResultMessage` in `src/agent/tools/toolResultStorage.ts`. The
line still carries the raw result as the top-level member `toolUseResult`,
written by `JSON.stringify` as `"toolUseResult":` followed by the value.

**Which lines.**
- The buffer is taken line by line, split on LF.
- A line qualifies when its bytes contain `<persisted-output>` anywhere, even inside the raw result itself, and `"toolUseResult":` anywhere.
- In a qualifying line, the first member of the outermost object spelled exactly `"toolUseResult":` (no space before the colon, not inside a string, not in a nested object) is removed with its value.

**What is removed,** for a valid JSON value of any kind (string with escapes,
number, `true`, `false`, `null`, object or array, strings holding brackets or
escaped quotes). The examples are qualifying lines, their preview tag left out:
- **When a comma follows the value** (after optional whitespace): from the member's opening quote through that comma. Whitespace after the comma stays: `{"a":1, "toolUseResult": {"x":1} , "b":2}` becomes `{"a":1,  "b":2}`.
- **Otherwise, when a comma precedes the member:** from that comma through the end of the value, whitespace between them included: `{"a":1 ,  "toolUseResult":[1,2] }` becomes `{"a":1  }`.
  - A number, `true`, `false` or `null` runs up to the next `,` or `}`, so whitespace after it goes too.
- **A lone member** leaves `{}`.
- **A value that runs to the end of the line** (a line cut by a crash) takes the rest of the line with it.

**What stays the same.**
- **The bytes.** Nothing is re-serialized: every other byte, LF, CR, empty lines and a last line without LF come back unchanged.
- **The buffers.** When no line changed, including when either marker is missing from the whole buffer, the same `Buffer` instance is returned. Otherwise a new one is returned, and the input is never modified.

**No parsing.** The line is never parsed. A raw result of several megabytes that
is not valid JSON, but has balanced brackets, is removed exactly, and the rest of
the line comes back byte for byte (see Security requirements).

The fixture pair `src/sessions/__fixtures__/rewrite/persisted-output.{input,stripped}.jsonl`
pins a real transcript byte for byte. Lines 3, 6 and 8 change: a middle member,
a last member, and a string value. Line 5 (no preview) and line 7 (the member
one level down, in a legacy progress entry) do not.

### 9. Visiting JSONL entries: `forEachParsedJSONLBufferEntry(buf, visit)`

- **Lines.** The buffer is split on LF, and each line is decoded as UTF-8 and trimmed. Trimming covers spaces, tabs, CR and a byte-order mark at the start of the buffer or of any line.
- **What is visited.** Empty lines are skipped. Every other line is parsed as JSON, and its value, whatever it is (object, number, string, `null`, array), goes to `visit`, in order. A last line without LF is visited too.
- **Errors.** A line that does not parse is skipped. An error thrown by `visit` is swallowed too, and the walk goes on with the next line (see finding 7).

### 10. Loading a large transcript: `readTranscriptForLoad(filePath, fileSize)`

The resume loader calls it for transcripts over `SKIP_PRECOMPACT_THRESHOLD`
(5 MiB). It relies on `boundaryStartOffset > 0` to go back for session metadata
written before the cut.

**The input.**
- **Bytes.** It reads the first `fileSize` bytes, or up to the end when the file is shorter.
- **Lines.** A line is everything up to and including an LF, and the last line may lack one.
- **Parsing.** No line is parsed except a boundary candidate, so lines of any length and content pass through untouched.

**Attribution snapshots.**
- **Which lines.** A line whose first 30 bytes are exactly `{"type":"attribution-snapshot"` is a snapshot. Other key orders or spacing are not recognised, and those lines stay in place.
- **What happens to them.** Every snapshot is removed from its place, and the last one after the last cut is appended at the end, with its own LF if it had one. When the output so far is non-empty and does not end in LF, one LF is inserted before it, so the output can be one byte longer than the input.

**Compact boundaries.**
- **What counts as one.** A line is a boundary when the 18 bytes `"compact_boundary"` begin within its first 256 bytes and the line parses as JSON with `type` `'system'` and `subtype` `'compact_boundary'`. A line that fails to parse, another type, or another subtype is not.
- **An ordinary boundary** discards everything before it, including snapshots seen so far. The output starts at the boundary line, which is kept, `boundaryStartOffset` becomes the line's byte offset in the file, and `hasPreservedSegment` becomes false.
- **A preserved-segment boundary** (a truthy `compactMetadata.preservedSegment`) cuts nothing and sets `hasPreservedSegment` to true. `boundaryStartOffset` keeps the offset of the last ordinary boundary, or 0.
- **In sequence.** After a preserved boundary, an ordinary one cuts and clears the flag. After an ordinary one, a preserved one keeps the cut and sets the flag.

**Independence from how the file is read.** The result must not depend on where
a line falls relative to the reader's own read size.
- **Where it shows.** The old module's results changed at multiples of 1 MiB (finding 2).
- **The suite** therefore places ordinary lines, snapshots (with fewer and with more than 30 bytes before the offset, and longer than 1 MiB), boundaries (marker split, preserved) and an unterminated last line across 1 MiB offsets.
- **What the old module does not meet.** Finding 2 is the one case that fails today, and it is not pinned.

**The fixtures.** `compacted.{input,loaded}.jsonl` pin a real compacted
transcript: the boundary at offset 1971, and the latest snapshot at the end.
`preserved.{input,loaded}.jsonl` pin a preserved boundary: no cut, and an LF
inserted before the moved snapshot.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `readTranscriptForLoad` on a missing file | rejects with `ENOENT` |
| `readTranscriptForLoad` on an empty file | an empty buffer, offset 0, flag false |
| `readHeadAndTail` on anything unreadable, or with a short buffer | `{ head: '', tail: '' }`; never rejects |
| a boundary whose marker starts at byte 256 or later of its line | not a boundary (the 255/256 edge is pinned); see finding 11 |
| a snapshot line with another first key, or a space after `{` | stays where it is |
| `"toolUseResult" :` (space before the colon) | not recognised; the line is unchanged |
| the same member name twice at the top level | only the first is removed. Not pinned |
| a preview tag and the member on different lines | nothing changes; the same buffer comes back |
| short cwds that differ only in punctuation (`/work/acme-api`, `/work/acme/api`) | the same project directory (pinned); finding 9 |
| a cwd of exactly 200 characters after sanitizing | kept whole; at 201 the hash suffix appears |
| `getProjectDir` (barrel) after `CLAUDIN_CONFIG_DIR` changes | the old path until `cache.clear()`; finding 8 |
| `setAgentTranscriptSubdir(agent, '')` | the plain `subagents/` path |
| a JSONL line that is valid JSON but not an object (`null`, `42`) | handed to the visitor as that value |
| a user text made only of whitespace | `''` as the title, and the scan stops there; finding 4. Not pinned |
| a prompt pasted with CRLF | the CR survives into the title. Finding 5. Not pinned |
| a head chunk that opens with a compact summary | the summary text becomes the title; finding 3. Not pinned |
| `extractTag` edge cases (nesting, attributes) | whatever `src/agent/messages/text.ts` does; not this unit's contract |

## Security requirements

**Pinned by the tests:**
- **No parse of a raw result.** Stripping never parses the line or materializes the raw result. Resume exists to avoid loading multi-megabyte blobs, and parsing them is what ran long sessions out of memory. The suite strips a 6 MiB raw result that is not valid JSON.
- **No parse of ordinary lines on load.** `readTranscriptForLoad` parses only lines that carry the boundary marker within their first 256 bytes. The suite passes a 3 MB non-JSON line through.
- **Directory names cannot escape.** A `sanitizePath` result holds only `A`–`Z`, `a`–`z`, `0`–`9` and `-`, so no cwd can name a directory outside `projects/` or contain a separator.

**Not pinned:**
- **Path components are joined without validation.** A session id, an agent id or a subagent subdirectory containing `..` or `/` changes the path. Today the callers keep this safe:
  - session ids are UUIDs, and `--resume` input goes through `validateUuid` in `src/sessions/sessionCandidates.ts`;
  - agent ids are generated;
  - the only subdirectory is `workflows/<runId>`, where `runId` is 12 random hex characters (`src/tools/AgentWorkflow/runStore.ts`).

  Finding 12 hardens the subdirectory.

## Tests that pin it

- **The characterization suite, 166 tests in four files.** Coverage of the old code: `sessionStoragePortable.ts` 99.7% of lines, `firstPrompt.ts` 99.2%, `jsonlStripping.ts` 97.1%, `logging.ts` 94.2%, `paths.ts` and `typeGuards.ts` 100%.
  - **`src/sessions/storagePure.characterization.test.ts`** (54): guards, logging filters, titles. The messages come from the real factories.
  - **`src/sessions/storagePure.paths.characterization.test.ts`** (16): paths. Each test uses its own `CLAUDIN_CONFIG_DIR` and restores the bootstrap session state it moves.
  - **`src/sessions/storagePure.jsonl.characterization.test.ts`** (29): stripping and the line visitor.
  - **`src/sessions/storagePure.portable.characterization.test.ts`** (67): the portable module, on real files in a fresh temp directory per test.
    - **Both suffixes.** The Bun suffix is pinned in-process. For the Node one, the test bundles `sessionStoragePortable.ts` alone with `Bun.build` and runs it under `node`. It needs `node` on `PATH`, which CI provides.
- **The fixtures, in `src/sessions/__fixtures__/rewrite/`.** They were generated once from the real message factories, with the transcript writer's key order, and the expected files come from an independent oracle: the entry serialized without `toolUseResult`, and the line selection above.
  - `persisted-output.input.jsonl` and `persisted-output.stripped.jsonl`;
  - `compacted.input.jsonl` and `compacted.loaded.jsonl`;
  - `preserved.input.jsonl` and `preserved.loaded.jsonl`;
  - `session-head.jsonl`.
- **The probe spec, `scripts/migrations/probes/rewrite-sessions-storagePure.json`.** 40 probes over all six files. Every one turns the suite red.
- **Existing tests,** this project's own, which stay and must keep passing:
  - `src/sessions/__tests__/pure.test.ts`, with its snapshot `__snapshots__/pure.test.ts.snap`. It pins a stripped buffer by SHA-256 and the redacted output of `cleanMessagesForLogging`.
  - `src/sessions/__tests__/barrelExports.test.ts`, with its snapshot: the barrel's names.
  - `src/sessions/resumePrefixDeterminism.test.ts`: logged transcripts replay to the same request bytes.
  - `src/sessions/pure/attachmentPersistence.test.ts`: the attachment policy that `isLoggableMessage` applies.
  - `src/sessions/__tests__/{characterization,project,resumeRoundTrip}.test.ts`, which use the paths and the stripper.
- **Model-facing text.** The unit sends none to a model, so no prompt snapshot depends on it.
- **Not pinned, and why:**
  - **The byte-order mark skipped at the very start of `forEachParsedJSONLBufferEntry`'s buffer.** Trimming already removes it, so no test can tell the two apart.
  - **Windows path joining.** The suite runs on POSIX. Windows-style names are pinned only through `sanitizePath`.
  - **Behaviour that findings 2 to 5, 8, 10 and 12 change,** so that the suite passes on both the old and the new code.

## Out of scope

- **Unused exports.** Eight exports have no importer, and `knip-baseline.json` lists all of them. Drop them, and refresh the knip baseline in the same change.
  - The six byte helpers of `jsonlStripping.ts`: `PERSISTED_OUTPUT_TAG`, `TOOL_USE_RESULT_KEY`, `isJsonWhitespaceByte`, `skipJsonWhitespace`, `findJsonValueEnd` and `stripPersistedToolUseResultFromLine`.
  - `MAX_SANITIZED_LENGTH` and `unescapeJsonString` from the portable module.

  Their behaviour survives in sections 5, 6 and 8. The header comment of `src/sessions/sessionStorage.ts` names three of the helpers, so reword it in the same change.
- **An `ant` user type.** `getUserType()` never returns anything but `'external'`, so logging behaves only as described. Keep `getUserType` for its caller.

## Findings

1. **The directory name of a long cwd depends on the runtime.**
   - **The defect.** Under Bun the suffix was the base-36 `Bun.hash` of the name, and under Node it was the one in section 5.
   - **Who sees which.** The package published to npm installs a native binary built with `bun --compile`: `install.cjs` hardlinks it over the `bin/claudin.exe` stub, so an installed CLI runs on Bun and stores the Bun suffix. The Node bundle is its fallback (`cli-wrapper.cjs`, and `--ignore-scripts` installs), and `bin/claudin` in a checkout runs Node too; those store the Node suffix. A user who moves between the two sees another directory for the same long cwd, and `/resume` misses the sessions stored under the other one.
   - **Decision: keep for parity.** Settling on either suffix orphans the sessions stored under the other, and the native binary is the main distribution. The fix is a lookup that tolerates both, such as falling back to a sibling directory with the same 200-character prefix, and it is tracked in `.claudin/memory/team/bugs/long-cwd-project-dir-depends-on-runtime.md` rather than made here. `scripts/bench/ab/read-strategy-ab.ts` keeps its own copy of the rule; point it at `sanitizePath` in the rewrite.
2. **A compact boundary is missed where it crosses a 1 MiB offset.**
   - **The defect.** The transcript writer puts `parentUuid` first. A boundary line laid out that way, with 30 or more of its bytes before a multiple of 1 MiB, is not recognised by `readTranscriptForLoad`. The same line anywhere else is.
   - **The cost of a missed ordinary boundary** is memory: the history before it is loaded.
   - **The cost of a missed preserved boundary** is messages: `hasPreservedSegment` comes back false, and the loader then prunes the chain before parsing, which drops the preserved messages as orphans (`src/sessions/resume/transcriptLoad.ts`, the comment above the pre-parse walk).
   - **The other direction.** A line that starts with `{"type":"system"` and crosses such an offset is parsed without the 256-byte limit.
   - **Decision: fix.** One rule, wherever the line falls. No stored data or workflow can depend on where a 1 MiB offset lands. Not pinned; the rewrite adds the test.
3. **The chunk reading does not skip compact summaries.** The message reading does. A fork of a compacted session opens with the summary, so the resume picker titles it with the summary text. **Decision: fix.** Skip `isCompactSummary` lines in both. Titles are computed when read, so nothing stored depends on them. Not pinned.
4. **A whitespace-only prompt blanks the title.** In the chunk reading, a text that is empty after flattening is returned as `''`, which also hides every later prompt and the command fallback. `extractFirstPrompt` returns `''` instead of `No prompt`. **Decision: fix.** Treat such a text as empty and keep looking. Not pinned.
5. **Titles keep carriage returns.** Only LF is flattened, so a pasted CRLF prompt keeps a CR in its title. **Decision: fix.** Flatten CR and CRLF too; titles are display-only. Not pinned.
6. **A preview tag anywhere on the line is enough.** A tool result kept inline loses its raw result on resume when the tag appears elsewhere on the line, for example in the raw output of a tool that read a file mentioning the tag. **Decision: keep for parity.** Narrowing it needs to know where the tag sits, which the byte-level design avoids, and the model-facing content is untouched. Pinned.
7. **`forEachParsedJSONLBufferEntry` swallows the visitor's errors as well as parse errors.** **Decision: keep for parity.** The resume loader's visitor reads `entry.type` without a null check, so a `null` line in a stored transcript is skipped only because of this. Pinned.
8. **The barrel's `getProjectDir` memo is keyed on the cwd alone.** After `CLAUDIN_CONFIG_DIR` changes, it returns the old path until `cache.clear()`. **Decision: fix.** Key it on the config home as well, or drop the memo, but keep a callable `cache.clear()` for the five tests. The process never changes the variable, so no caller relies on the stale path. The suite pins only `cache.clear()` and the path after it.
9. **Short cwds collide.** Any two cwds that sanitize alike share a project directory: `/work/acme-api` and `/work/acme/api`. Their sessions list together, and `--continue` can pick the other project's session. **Decision: keep for parity.** The directory name is stored data, and changing it would orphan every existing session. Pinned.
10. **Field reads rank the two forms before position.** Both field readers search the compact form fully before the spaced one, so first and last are per form. **Decision: fix.** Choose by position across both forms. The writer never emits the spaced form, and the pinned cases hold either way. Not pinned.
11. **The 256-byte marker window is a heuristic.** A real boundary with long `teamName`, `agentName` and `agentId` members before `type` can exceed it, and then finding 2's consequences follow. **Decision: keep for parity.** The window is what keeps the loader from parsing large lines. Pinned at 255/256.
12. **The subagent subdirectory is not validated.** It is joined into the path as given. **Decision: fix, as hardening.** A subdirectory that is absolute or has a `..` segment is ignored, and the transcript goes to the plain `subagents/` path. The only caller passes `workflows/<12 hex characters>`, so legitimate use never notices. Not pinned.

## Target design

- **A pure core.** The guards, the logging filter, the title rules, `sanitizePath`, the field readers and the JSONL byte scanning are pure functions, with no module state and no I/O.
- **One set of title rules** serves both readings. The two readings differ only in how they get candidate texts (parsed messages, or filtered raw lines) and in whether a text is flattened first. Findings 3 to 5 then land in one place.
- **One byte scanner for JSON values.** It finds where a value ends, respecting strings and escapes, and drives the stripper. It is not exported (see Out of scope).
- **A line splitter** for large transcripts, independent of its read size, feeding a line classifier (snapshot, boundary candidate, other). That makes finding 2 impossible by construction. The output grows without holding two copies of the file.
- **Paths as a small module.** It has an explicit memo keyed on config home and cwd that still exposes `cache.clear()`, and a per-agent subdirectory map with its hardening (finding 12).
- **The portable module stays portable.** It imports no barrel, no bootstrap state and no logging, and uses `djb2Hash` for the suffix on every runtime.
- **Explicit types.** No `any`, regexes at module level, and `EPHEMERAL_PROGRESS_TYPES` typed as a `ReadonlySet` where callers allow it. The only errors swallowed are the documented ones: sections 7 and 9, and parse failures of boundary candidates.
- **Call-time reads.** The environment, bootstrap state and config home are read at call time, because the tests change them between calls.
