# Spec: `sessions/liteMetadata`

## Purpose

The session index. A session is a JSONL transcript named `<session id>.jsonl`
in the project directory of its cwd, under `<config home>/projects/`. This unit
answers three questions about those files:

- **Which sessions does a project have, and what does each look like in a list?** A stat-only listing, then an enrichment that reads only the first and last 64 KiB of each file. This is the fast pass behind the `/resume` picker, `--continue`, title search and the auto-dream digest.
- **What does a session hold in full?** Its messages, rebuilt along the `parentUuid` chain, and the metadata entries of its session (title, tag, agent, PR link, cost, worktree, snapshots).
- **Which sessions carry a title?** `searchSessionsByCustomTitle` searches the titles of every worktree of the current repository.

Two files: `src/sessions/indexing/liteMetadata.ts` and `src/sessions/indexing/search.ts`.
Most names reach callers through the session-storage barrel
(`src/sessions/sessionStorage.ts`).

The unit reads transcripts that users keep across versions, so every rule about
what is read from where is a compatibility rule. It writes nothing.

## Public contract

The barrel must keep re-exporting every name it re-exports today:
`src/sessions/__tests__/barrelExports.test.ts` pins the list with a snapshot.
`LogOption` and `TranscriptMessage` are in `src/shared/types/logs.ts`.

**Through the barrel** (`src/sessions/sessionStorage.ts`):

| Export | Signature | Used by |
|---|---|---|
| `getNodeEnv` | `() => string` | nothing outside the unit; kept for the barrel |
| `isCustomTitleEnabled` | `() => boolean` | `commands/resume/resume.tsx`, `sessions/ui/ResumeConversation.tsx`, `terminal/tips/tipRegistry.ts` |
| `INITIAL_ENRICH_COUNT` | `number` (50) | directly by `sessions/indexing/crossProject.ts` |
| `loadTranscriptFromFile` | `(filePath: string) => Promise<LogOption>` | nothing outside the unit; kept for the barrel |
| `fetchLogs` | `(limit?: number) => Promise<LogOption[]>` | nothing outside the unit; kept for the barrel |
| `getSessionIdFromLog` | `(log: LogOption) => UUID \| undefined` | `commands/resume/resume.tsx`, `platform/main/defaultAction/resume.ts`, `sessions/conversationRecovery.ts`, `sessions/crossProjectResume.ts`, `sessions/ui/SessionPreview.tsx`, `terminal/hooks/useTypeahead.tsx`; directly by `sessions/ui/sessionRows.ts` and `search.ts` |
| `isLiteLog` | `(log: LogOption) => boolean` | `commands/resume/resume.tsx`, `sessions/conversationRecovery.ts`, `sessions/ui/SessionPreview.tsx` |
| `loadFullLog` | `(log: LogOption) => Promise<LogOption>` | the same three |
| `getLastSessionLog` | `(sessionId: UUID) => Promise<LogOption \| null>` | `commands/resume/resume.tsx`, `sessions/conversationRecovery.ts` (`--resume <session id>`) |
| `loadMessageLogs` | `(limit?: number) => Promise<LogOption[]>` | `sessions/conversationRecovery.ts` (`--continue`) |
| `getLogByIndex` | `(index: number) => Promise<LogOption \| null>` | nothing outside the unit; kept for the barrel |
| `findUnresolvedToolUse` | `(toolUseId: string) => Promise<AssistantMessage \| null>` | `platform/headless/print/orphanPermission.ts` |
| `getSessionFilesWithMtime` | `(projectDir: string) => Promise<Map<string, { path: string; mtime: number; ctime: number; size: number }>>` | directly by `commands/auto-mode-setup/collectSignals.ts`, `platform/usageContribution/usageContribution.ts` |
| `getSessionFilesLite` | `(projectDir: string, limit?: number, projectPath?: string) => Promise<LogOption[]>` | directly by `sessions/indexing/crossProject.ts`, `memory/autoDream/dreamDigest.ts` |
| `enrichLogs` | `(allLogs: LogOption[], startIndex: number, count: number) => Promise<{ logs: LogOption[]; nextIndex: number }>` | `sessions/ui/ResumeConversation.tsx`; directly by `crossProject.ts`, `dreamDigest.ts`, `search.ts` |
| `loadAllLogsFromSessionFile` | `(sessionFile: string, projectPathOverride?: string) => Promise<LogOption[]>` | nothing outside the unit; kept for the barrel |
| `searchSessionsByCustomTitle` | `(query: string, options?: { limit?: number; exact?: boolean }) => Promise<LogOption[]>` | `commands/branch/branch.ts`, `commands/resume/resume.tsx`, `platform/main/defaultAction/resume.ts`, `terminal/hooks/useTypeahead.tsx` |

**Straight from `src/sessions/indexing/liteMetadata.ts`:**

| Export | Signature | Used by |
|---|---|---|
| `deduplicateLogsBySessionId` | `(logs: LogOption[]) => LogOption[]` | `sessions/indexing/crossProject.ts` |
| `getLogsWithoutIndex` | `(projectDir: string, limit?: number) => Promise<LogOption[]>` | `sessions/indexing/crossProject.ts` |

Two more exports have no importer; see Out of scope.

**What it relies on**, all outside the unit and specified in
[storagePure.md](storagePure.md) and the `sessions/resume` unit: the project
directory of a cwd, the head-and-tail reader and the string-field readers of
`sessionStoragePortable.ts`, the two title readings (`extractFirstPrompt` and
`extractFirstPromptFromChunk`), the transcript loader
(`src/sessions/resume/transcriptLoad.ts`), the chain builder
(`src/sessions/resume/chain.ts`), the persisted-message cache
(`src/sessions/resume/cache.ts`), the tail figures
(`src/sessions/indexing/sessionStats.ts`), `sortLogs`, and
`getWorktreePaths` with the worktree listing of `crossProject.ts`.

## Observable behaviour

### 1. Switches and constants

- **`isCustomTitleEnabled()`** is `true`, always.
- **`INITIAL_ENRICH_COUNT`** is 50: how many sessions the picker enriches up front.
- **`getNodeEnv()`** returns `NODE_ENV`, read at call time, or `'development'` when it is unset or empty.

### 2. The files of a project: `getSessionFilesWithMtime(projectDir)`

- A session file is a **regular file** in `projectDir` (not a directory, not a symlink) whose name is `<uuid>.jsonl`, the UUID in either letter case. Nothing below `projectDir` is looked at.
- The result maps the name without `.jsonl`, letter case kept, to `{ path, mtime, ctime, size }`. `mtime` is the modification time in milliseconds, `ctime` is the **birth** time in milliseconds, and `size` is in bytes.
- A directory that does not exist gives an empty map. A file that cannot be stat'ed is left out.

### 3. The stat-only listing: `getSessionFilesLite(projectDir, limit?, projectPath?)`

- One record per session file. Nothing is read from the files.
- **Order:** newest `mtime` first; equal times fall back to newer birth time (`sortLogs`). `value` is the position, from 0.
- **Limit:** a truthy `limit` smaller than the number of files keeps that many of the newest. `0` and `undefined` keep all.
- **Each record:** `date` is the mtime as an ISO string; `messages: []`; `isLite: true`; `fullPath`; `created` (birth time) and `modified` (mtime) as `Date`s; `firstPrompt: ''`; `messageCount: 0`; `fileSize`; `isSidechain: false`; `sessionId`; `projectPath` exactly as passed (possibly `undefined`).
- A directory that does not exist gives `[]`.

### 4. Enrichment: `enrichLogs(allLogs, startIndex, count)`

**The scan.** Starting at `startIndex`, records are taken in order until
`count` of them are kept or the list ends. `nextIndex` is the index after the
last record looked at. `count` 0, or a start past the end, gives `[]` with
`nextIndex === startIndex`. Hidden sessions (below) do not count toward
`count`, so scanning goes on past them.

**Records that are not lite, or have no `fullPath`,** are kept as the same
object, unchanged.

**A lite record** becomes a new object: everything it had, with `isLite: false`
and the fields below replaced. `messages` stays `[]` and `messageCount` stays
0, so `isLiteLog` is still true for it and `loadFullLog` completes it on demand.

The file is read as its first 64 KiB (the **head**) and its last 64 KiB (the
**tail**), the tail placed by the record's `fileSize`. When the file is at most
64 KiB, head and tail are the whole file. Nothing between them is seen.
"Last" and "first" below are by position in that text. Field values are read
as JSON strings and decoded (escapes, `\uXXXX`).

| Field | Read from |
|---|---|
| `firstPrompt` | the last `lastPrompt` value in the tail, when non-empty; else the title of the head by `extractFirstPromptFromChunk`; else the start of the first `"content":"` string in the head; else the start of the first `"text":"` string in the head; else `''`. "The start" is up to 200 characters, stopping at the closing quote if there is one, with `\n` and `\t` escapes turned into spaces and the result trimmed. |
| `customTitle` | the last `customTitle` in the tail; else the last `customTitle` in the head; else the last `aiTitle` in the tail; else the last `aiTitle` in the head. So an AI title shows as the custom title when the user never named the session. |
| `tag` | the last `tag` in the tail only |
| `gitBranch` | the last `gitBranch` in the tail; else the first in the head |
| `projectPath` | the first `cwd` in the head; else the record's own `projectPath` |
| `teamName`, `agentSetting` | the first occurrence in the head |
| `isSidechain` | true when the head contains `"isSidechain":true` or `"isSidechain": true` |
| `prUrl`, `prRepository` | the last occurrence in the tail |
| `prNumber` | the last `prNumber` string value in the tail, parsed as an integer; when that is missing or not a positive-looking number, the number after the last `"prNumber":` in the tail (a space after the colon is allowed), kept only when greater than 0 |
| `summary` | the text of the last `summary` entry in the tail, whatever leaf it names |
| `costUSD` | `totalCostUSD` of the last `cost-state` entry in the tail |
| `contextTokens` | for the last assistant line in the tail that is not a sidechain and reports a non-zero usage: input + cache creation + cache read + output tokens. Missing or `null` cache counts count as 0. |

**The placeholder title.** When `firstPrompt` and `customTitle` are both
empty, `firstPrompt` becomes `'(session)'`. This includes an empty file and a
file that disappeared or cannot be read after listing.

**Hidden sessions.** A record whose enrichment says `isSidechain`, or has a
`teamName`, is dropped: it never reaches the picker or `--continue`.

### 5. The current project: `fetchLogs`, `loadMessageLogs`, `getLogByIndex`

- **`fetchLogs(limit?)`** is the stat-only listing of the project directory of the original cwd, with `projectPath` set to the original cwd.
- **`loadMessageLogs(limit?)`** enriches all of `fetchLogs(limit)`, drops hidden sessions, sorts newest first and renumbers `value` from 0. The limit counts files before hidden ones are dropped. `--continue` resumes its first record.
- **`getLogByIndex(i)`** is record `i` of `loadMessageLogs()`, or `null`.

### 6. Reading a record: `getSessionIdFromLog`, `isLiteLog`

- **`getSessionIdFromLog(log)`** is `log.sessionId` when set, else the `sessionId` of `log.messages[0]`, else `undefined`. A full record of a fork therefore names the session its first message came from.
- **`isLiteLog(log)`** is true when `messages` is empty and `sessionId` is set.

### 7. A record from messages

`getLastSessionLog` and `loadTranscriptFromFile` build a record from a list of
messages (root first) the same way:

- `date` is the last message's timestamp string; `created` and `modified` are the first and last timestamps as `Date`s.
- `messages` are copies without `parentUuid` and `isSidechain`, in order.
- `firstPrompt` is `extractFirstPrompt` of the messages (`'No prompt'` when there is none).
- `messageCount` counts the turns a user sees:
  - a user message counts when it is not `isMeta` and its content is a non-blank string, or a list holding at least one `text` (even empty), `image` or `document` block;
  - an assistant message counts when its content is a list holding a `text` block with non-blank text. A string content does not count;
  - nothing else counts (tool results, tool calls, thinking, system, attachment, progress).
- `isSidechain`, `teamName`, `agentName` and `projectPath` (its `cwd`) come from the first message; `gitBranch` and `leafUuid` from the last.
- `value` is 0, and no `sessionId` member is set.
- An empty list is refused with `Cannot build session metadata from an empty transcript`.

### 8. Loading a file: `loadTranscriptFromFile(filePath)`

- **A `.jsonl` path** is loaded with the transcript loader. The leaf is the newest branch end (by timestamp; see finding 1 for ties), and the messages are its chain. Added: `fullPath`; `summary` of that leaf; `customTitle` and `tag` of the leaf's session; `worktreeSession` of that session, or `undefined`; the context-collapse commits of that session in file order; the collapse snapshot when it belongs to that session.
  - No message at all (an empty or missing file) rejects with `No messages found in JSONL file`.
  - Messages but no user or assistant branch end rejects with `No valid conversation chain found in JSONL file`.
- **Any other path** is read as JSON: a list of messages, or an object whose `messages` is a list. The messages are taken as given, in order, with no chain building and no metadata (section 7). It rejects with:
  - `Invalid JSON in transcript file: ` followed by the parse error;
  - `Transcript messages must be an array` for an object whose `messages` is not a list;
  - `Transcript must be an array of messages or an object with a messages array` for anything else;
  - the read error itself (for example `ENOENT`) when the file cannot be read.

### 9. Completing a listed record: `loadFullLog(log)`

- It returns the **same object** when the record is not lite, has no `fullPath`, or its file yields no user or assistant branch end (missing, empty, unreadable, or only system messages). It never rejects.
- Otherwise it returns a new object: every field of `log`, with these replaced. The anchor is the newest user or assistant branch end of the file (finding 1 for ties), and "its session" is the `sessionId` of that anchor, which differs from the first message's in a fork.
  - `messages`: the chain to the anchor, without `parentUuid` and `isSidechain`. Messages after the anchor that are not user or assistant (a closing system note) are not included.
  - `firstPrompt` and `messageCount`, recomputed from the chain (section 7). The listing's last-prompt value is replaced by the first prompt.
  - `summary`: the summary entry naming the anchor.
  - `customTitle`, `tag`, `agentName`, `agentColor`, `agentSetting`, `mode`, `costState`, `prNumber`, `prUrl`, `prRepository`: the last entry of each kind for its session, or `undefined` when there is none. An AI title is not a custom title here, so a session the listing showed under its AI title loses it.
  - `worktreeSession`: the last `worktree-state` entry of its session, `null` included; the record's own value when there is no such entry.
  - `gitBranch`, `leafUuid`: the anchor's. `isSidechain`, `teamName`: the first chain message's.
  - `fileHistorySnapshots`: the snapshots attached to chain messages, in chain order; a snapshot update replaces the earlier snapshot with the same inner `messageId`.
  - `attributionSnapshots`: every attribution snapshot in the file.
  - `contextCollapseCommits`: the commits of its session, in file order; `contextCollapseSnapshot`: the last snapshot when it belongs to its session.
- Kept from the record as they were: `sessionId`, `fullPath`, `value`, `date`, `created`, `modified`, `fileSize`, `projectPath`, `isLite`, `costUSD`, `contextTokens`.

### 10. Resuming by id: `getLastSessionLog(sessionId)`

- It reads `<dir>/<sessionId>.jsonl`, where `<dir>` is the current session's project directory when one is set (after a cross-project resume), else the project directory of the original cwd.
- `null` when the file has no messages, or no message that is not a sidechain.
- **The anchor** is the newest message by timestamp that is not a sidechain, of any type, so a closing system note is part of the chain. See finding 1 for ties.
- The record is built from the chain to the anchor (section 7), with:
  - `fullPath`: the transcript path of that session id (see finding 4);
  - `summary` naming the anchor; `customTitle` and `tag` of the anchor's session;
  - `agentSetting`, `worktreeSession`, `costState`, and the context-collapse commits of the **requested** session id; the collapse snapshot when it belongs to it;
  - `fileHistorySnapshots` and `attributionSnapshots` as in section 9.
- **The persisted-message cache.** When the cache of `doesMessageExistInSession` has no entry for that session, it is filled with the uuids just read, so the next lookup does not read the file again. An entry already there is never replaced.

### 11. One record per branch: `loadAllLogsFromSessionFile(file, projectPathOverride?)` and `getLogsWithoutIndex(projectDir, limit?)`

- **`loadAllLogsFromSessionFile`** gives one record per user or assistant branch end of the file, in file order, keeping every branch:
  - `messages`: the chain to that end, then the messages whose parent is that end and that are not branch ends themselves (system notes, attachments), sorted by timestamp; all without `parentUuid` and `isSidechain`;
  - `date` and `modified` are the end's timestamp; `created` the first message's;
  - `firstPrompt`, `messageCount` as in section 7, over those messages;
  - `sessionId` and the session metadata (`customTitle`, `tag`, `agentName`, `agentColor`, `agentSetting`, `mode`, `prNumber`, `prUrl`, `prRepository`) of the end's session; `summary` naming the end; `gitBranch` and `leafUuid` of the end;
  - `isSidechain` of the first message, `false` when absent; `projectPath` is the override when given, else the first message's `cwd`;
  - snapshots as in section 9; `fullPath` is the file; `value` is 0; no `isLite`.
  - A missing file, or one without messages, gives `[]`.
- **`getLogsWithoutIndex`** concatenates `loadAllLogsFromSessionFile` over the session files of `projectDir` (section 2). With a `limit` smaller than the number of files, only the `limit` most recently modified files are read, newest first. Without one, the order of the files is not specified. A missing directory gives `[]`.

### 12. Deduplication: `deduplicateLogsBySessionId(logs)`

Records without a `sessionId` are dropped. Per session the record with the
latest `modified` stays; on a tie, the first one seen. The result is sorted
(`sortLogs`) and renumbered from 0, as new objects; the inputs keep their
`value`.

### 13. A pending tool call: `findUnresolvedToolUse(toolUseId)`

It reads the **current** session's transcript. It returns the assistant
message (as stored, `parentUuid` included) holding a `tool_use` block with that
id, and `null` when no such call exists, when any user message holds a
`tool_result` for that id, or when the transcript is missing.

### 14. Title search: `searchSessionsByCustomTitle(query, options?)`

- **Where.** The working trees of the repository holding the original cwd (`git worktree list`). Each worktree's project directory, and every directory in `projects/` whose name starts with that directory name followed by `-`, is listed. Outside a repository, or with a single worktree, only the original cwd's project directory.
- **What.** Every listed session is enriched (section 4), so hidden sessions never match and an AI title counts as a title.
- **Matching** is on the title lowercased and trimmed against the query lowercased and trimmed: a substring by default, the whole title with `exact: true`. Sessions without a title never match; an empty query matches every titled session.
- **Result.** Enriched records, one per session id (the latest `modified` stays), sorted newest first. A truthy `limit` keeps that many; `0` keeps all.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| A project directory that does not exist | empty map, `[]`, `null` or no match, from every export |
| An empty session file | listed; enriched as `'(session)'`; `loadFullLog` returns it unchanged with no messages, so `--continue` can resume an empty session |
| A file deleted between listing and enrichment | `'(session)'`; no rejection |
| A first line longer than 64 KiB | the chunk title fails to parse it; the title is the first 200 characters of its raw content |
| Metadata between the two 64 KiB windows | not in the listing; `loadFullLog` sees it |
| A tag only in the head, or a `lastPrompt` only in the head | not used |
| A sidechain flag only beyond the head | the session is listed |
| A prompt with escaped quotes, backslashes or `\u` escapes in a title or tag | decoded |
| A `.jsonl` given to `loadTranscriptFromFile` that does not exist | `No messages found in JSONL file`, not `ENOENT` |
| An export `.json` that does not exist | the read error (`ENOENT`) |
| A cycle in `parentUuid` | the chain stops where the cycle closes (the chain builder's rule) |
| A transcript over 5 MiB | the transcript loader's rules apply (pre-compact skip); this unit asks for every branch only in `loadAllLogsFromSessionFile` |
| `findUnresolvedToolUse` with no current transcript | `null` |
| A UUID file name in upper case | listed under that name, case kept |
| A symlink named like a session | not listed |

## Security requirements

**Pinned by the tests:**
- **Bounded reads for listing.** Enrichment reads at most 128 KiB per file (two 64 KiB windows through one reused buffer), whatever the file's size. A listing of thousands of sessions must not load transcripts.
- **No file outside the project directory.** Only regular files named `<uuid>.jsonl` directly in the project directory are listed; symlinks and directories are not followed. Session ids come from file names checked as UUIDs, so they cannot carry `/` or `..`.
- **Read-only.** No export writes or deletes a file. `getLastSessionLog` changes only the in-memory message cache, and only when it is empty for that session.

**Not pinned:**
- `getLastSessionLog` and `findUnresolvedToolUse` join the session id they are given into a path. Callers validate it: `--resume` input goes through `validateUuid` in `src/sessions/sessionCandidates.ts`, and the current session id is generated.
- Finding 2: a member name inside a tool input or result is read as session metadata. It can hide a session or mislabel it, but not reach outside the transcript.

## Tests that pin it

- **The characterization suite, 135 tests in four files, plus one harness.** Coverage of the old code: `liteMetadata.ts` 98.8% of lines, `search.ts` 100%. Every test writes real JSONL files into a fresh temp config home and project (`CLAUDIN_CONFIG_DIR`, the original cwd), and puts the bootstrap session state back.
  - **`src/sessions/indexing/liteMetadata.characterization.test.ts`** (40): switches, turn counting, records built from messages, `getSessionIdFromLog`, `isLiteLog`, deduplication, `loadTranscriptFromFile`.
  - **`src/sessions/indexing/liteMetadata.listing.characterization.test.ts`** (56): files on disk, the stat-only listing, enrichment of small and of large (over 2 × 64 KiB) transcripts, hidden sessions, `fetchLogs`, `loadMessageLogs`, `getLogByIndex`.
  - **`src/sessions/indexing/liteMetadata.loading.characterization.test.ts`** (27): `loadFullLog`, `getLastSessionLog` with its cache, finding 1, `loadAllLogsFromSessionFile`, `getLogsWithoutIndex`, `findUnresolvedToolUse`.
  - **`src/sessions/indexing/liteMetadata.search.characterization.test.ts`** (12): title search outside a repository, and in a real git repository with a linked worktree (`HOME`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1` and `GIT_CEILING_DIRECTORIES` isolated).
  - **`src/sessions/indexing/__testutils__/liteWorld.ts`**: the temp world, and lines in the transcript writer's key order.
- **The fixtures, in `src/sessions/indexing/__fixtures__/rewrite/`.**
  - `written-session.jsonl`: the output of the real transcript writer (`src/sessions/__testutils__/restoreHarness.ts`, `writeSession`) for a prompt and two replies with a title, tag, agent setting, PR link and cost, ids and paths normalized. The writer gave all three messages one timestamp, which is what finding 1 needs.
  - `written-session.listed.json`: the fields the listing shows for it.
- **The probe spec, `scripts/migrations/probes/rewrite-sessions-liteMetadata.json`.** 40 probes, 34 on `liteMetadata.ts` and 6 on `search.ts`. Every one turns the suite red.
- **Existing tests** that exercise the unit and must keep passing:
  - `src/sessions/__tests__/barrelExports.test.ts`, with its snapshot: the barrel's names.
  - `src/sessions/sessionRestore.costState.test.ts`: `getLastSessionLog` and `loadFullLog` carry the cost state.
  - `src/platform/main/defaultAction/resume.characterization.test.tsx`: `--resume` by id and by title, finding 1 included.
- **Model-facing text.** The unit sends none. `src/memory/autoDream/dreamDigest.ts` puts the listing's `firstPrompt`, `customTitle` and `summary` into its own prompt, so they are data there, not text of this unit.
- **Not pinned, and why:**
  - **The behaviour findings 2, 3 and 4 change,** so that the suite passes on both the old and the new code.
  - **A load that throws inside `loadFullLog`.** The transcript loader swallows its own errors, so no real input reaches it.
  - **`search.ts` keeping the newer of two records with one session id.** The listing it searches already holds one record per session id.
  - **Windows drive-letter case** in worktree matching (`crossProject.ts`'s rule). The suite runs on POSIX.

## Out of scope

- **Unused exports.** `convertToLogOption` and `countVisibleMessages` have no importer, and `knip-baseline.json` lists both. Their behaviour survives in section 7, pinned through `loadTranscriptFromFile` and `getLastSessionLog`. Make them private, and drop them from the knip baseline in the same change.
- **A branching count with no effect.** `fetchLogs` counts sessions that appear more than once and does nothing with the count. Drop it.
- **The `search.ts` header** names `boundaryScan.ts` and `loadSameRepoMessageLogs`; reword it with the module.

## Findings

1. **Messages that share a timestamp are lost by `--resume <session id>`.**
   - **The defect.** `getLastSessionLog` anchors the chain on the newest message by timestamp, and on a tie keeps the first one in the file. The transcript writer gives a quick exchange one timestamp (the fixture is its real output), so the anchor is the first message and the chain is that message alone. `conversationRecovery` then adds a synthetic "No response requested." reply. `--continue`, the picker and `--resume <title>` go through `loadFullLog`, which anchors on branch ends only, so they keep every message.
   - **Branches.** `loadFullLog` and `loadTranscriptFromFile` keep the first-written of two branch ends with the same timestamp.
   - **The same root cause** is in `sessions/resume` (`findLatestMessage` in `src/sessions/resume/chain.ts`).
   - **Decision: fix.** On a tie, the message written later wins, for every anchor of this unit. No caller, stored transcript or workflow depends on losing messages, and transcripts are not changed. Fix it together with `sessions/resume`.
   - **Pinned as it stands**, in the loading suite under two test names that start `DEFECT, finding 1`, and in `src/platform/main/defaultAction/resume.characterization.test.tsx` ("messages with tied timestamps, resumed by session id"). The fix changes those three pins in the same commit. The two tests beside them, the listing path and `loadAllLogsFromSessionFile`, keep every message today and stay as they are.
2. **The listing reads a member name wherever it appears on a line.**
   - **The defect.** Every listed field is found by its quoted name followed by a colon. A tool input or tool result stored as an object with a member of the same name counts. An MCP tool called with `{"tag": "v2"}` in the last 64 KiB tags the session `v2`. A `teamName` member anywhere in the first 64 KiB, or a `"isSidechain":true` from any line there, hides the session from `/resume`, `--continue` and search.
   - **Decision: fix.** Read each field only from the lines that carry it: titles, tag, last prompt, agent setting and PR link from entries of their own type; `cwd`, `gitBranch`, `teamName` and the sidechain flag from the top level of message lines. Listing values are computed when read, so nothing stored depends on them, and no legitimate transcript loses a value. Not pinned.
3. **The agent setting is read from the head only.**
   - **The defect.** The writer stores the agent setting by appending it at the end of the file when a session exits. In a transcript over 64 KiB the head no longer holds it, so the `@agent` label of the resume list (`src/shared/text/format.ts`) disappears. After the agent changes, the head still holds the first one.
   - **Decision: fix.** Read it like the branch: the last in the tail, else the first in the head. Display only. Not pinned; the suite pins a single agent-setting entry in a small file, where both rules agree.
4. **`getLastSessionLog` can report a path it did not read.**
   - **The defect.** After a cross-project resume, the current session's project directory is set. Asked for another session id, it reads `<that directory>/<id>.jsonl`, but `fullPath` names `<original cwd's project directory>/<id>.jsonl`.
   - **Decision: fix.** Report the path that was read. No caller can rely on a path to a file that may not exist. Not pinned; the suite pins the case where both agree (the requested id is the current session).
5. **An AI title is a title in the listing and in search, but not after a full load.**
   - **The behaviour.** The listing shows an AI title as `customTitle`, title search and `--resume <title>` match it, and `loadFullLog` replaces it with `undefined`.
   - **Decision: keep for parity.** Users resume by the title the picker shows them. The full load must not turn an AI title into a user title: the session would then write it back as a `custom-title` entry. Pinned.
6. **The listing's `firstPrompt` is the most recent prompt.** When a `last-prompt` entry exists, the listing shows the last prompt under that name, and the full load the first. **Decision: keep for parity.** It shows what the user was last doing, which is what the picker wants; the name is contract. Pinned.

## Target design

- **Three responsibilities, three modules,** all under `src/sessions/indexing/`:
  - **listing** (`getSessionFilesWithMtime`, `getSessionFilesLite`, `fetchLogs`): file stats only;
  - **lite reading** (`enrichLogs` and the head/tail field rules): a pure function from `{ head, tail }` to the listed fields, plus a thin reader that owns the shared 64 KiB buffer. Findings 2 and 3 land here: classify each line of the window by entry type first, then read the fields of that type;
  - **full loading** (`loadFullLog`, `getLastSessionLog`, `loadTranscriptFromFile`, `loadAllLogsFromSessionFile`, `getLogsWithoutIndex`, `findUnresolvedToolUse`): one function that turns a loaded transcript, an anchor and a session id into a record, so the record rules of sections 7 to 11 live in one place.
- **One anchor rule.** A single "newest message, ties to the later one" choice, used by every loader (finding 1), with the predicate (branch ends, or any non-sidechain message) passed in.
- **Search stays a thin filter** over the worktree listing and enrichment. Its per-session deduplication can go, since the listing already holds one record per session id.
- **Explicit types.** The listed fields as a named type, no `any`, regexes and limits (64 KiB, 200 characters, 50) as module constants. No error swallowed except the documented ones: an unreadable file lists as `'(session)'`, and a failed full load returns the record unchanged.
- **Call-time reads.** The config home, the original cwd and the current session's directory are read at call time, because the tests change them between calls.
