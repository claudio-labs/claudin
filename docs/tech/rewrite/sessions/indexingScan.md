# Spec: `sessions/indexingScan`

## Purpose

Three small pieces of session storage that sit beside the session index:

- **Two byte walkers for large transcripts.** The resume loader runs them on transcripts over 5 MiB, before it parses anything.
  - The **pre-boundary scan** reads the bytes in front of the last compact boundary and returns only the session-metadata lines found there: titles, tags, agent settings, PR links and the like. The loader skips those bytes otherwise, but the metadata in them still applies.
  - The **chain walk** takes a transcript buffer and drops the messages that are not on the live conversation chain: the dead branches left by every rewind and fork.
- **The session listings behind `/resume`.** The sessions of every worktree of the current repository, or of every project, as cheap stat-only entries plus a first batch read for their titles.
- **Local agent sidecars.** A small JSON file beside each subagent transcript that remembers how the agent was spawned, so that resuming it restores its type, worktree, description and read-only flag. Also the check of whether a session id already has a transcript.

Transcripts and sidecars are files users keep across versions, so every rule
about bytes on disk below is a compatibility rule.

The unit is three files under `src/sessions/indexing/`: `boundaryScan.ts`,
`crossProject.ts` and `agents.ts`. Most of their names reach callers through the
session-storage barrel (`src/sessions/sessionStorage.ts`). The two walkers and
`getStatOnlyLogsForWorktrees` are imported directly.

## Public contract

These keep their names and types, because the modules not yet rewritten import
them. The barrel must keep re-exporting the names it exports today:
`src/sessions/__tests__/barrelExports.test.ts` pins the list with a snapshot.

**Through the barrel** (`src/sessions/sessionStorage.ts`):

| Export | Signature | Used by |
|---|---|---|
| `AgentMetadata` (type) | `{ agentType: string; worktreePath?: string; description?: string; readOnly?: boolean }` | `tools/AgentTool/resumeAgent.ts` (imported straight from `agents.ts`) |
| `writeAgentMetadata` | `(agentId: AgentId, metadata: AgentMetadata) => Promise<void>` | `tools/AgentTool/runAgent.ts`, `tools/AgentTool/AgentTool.tsx` |
| `readAgentMetadata` | `(agentId: AgentId) => Promise<AgentMetadata \| null>` | `tools/AgentTool/resumeAgent.ts` |
| `sessionIdExists` | `(sessionId: string) => boolean` | `platform/main/action/parseOptions.ts` (`--session-id`), `shared/proc/gracefulShutdown.ts` (the resume hint at exit) |
| `SessionLogResult` (type) | `{ logs: LogOption[]; allStatLogs: LogOption[]; nextIndex: number }` | `sessions/ui/ResumeConversation.tsx` |
| `loadSameRepoMessageLogs` | `(worktreePaths: string[], limit?: number, initialEnrichCount?: number) => Promise<LogOption[]>` | `commands/resume/resume.tsx` |
| `loadSameRepoMessageLogsProgressive` | `(worktreePaths: string[], limit?: number, initialEnrichCount?: number) => Promise<SessionLogResult>` | `sessions/ui/ResumeConversation.tsx` |
| `loadAllProjectsMessageLogs` | `(limit?: number, options?: { skipIndex?: boolean; initialEnrichCount?: number }) => Promise<LogOption[]>` | `commands/resume/resume.tsx` |
| `loadAllProjectsMessageLogsProgressive` | `(limit?: number, initialEnrichCount?: number) => Promise<SessionLogResult>` | `sessions/ui/ResumeConversation.tsx` |

**Straight from the unit's files:**

| Export | Signature | Used by |
|---|---|---|
| `scanPreBoundaryMetadata` | `(filePath: string, endOffset: number) => Promise<string[]>` | `sessions/resume/transcriptLoad.ts` |
| `walkChainBeforeParse` | `(buf: Buffer) => Buffer` | `sessions/resume/transcriptLoad.ts` |
| `getStatOnlyLogsForWorktrees` | `(worktreePaths: string[], limit?: number) => Promise<LogOption[]>` | `sessions/indexing/search.ts` (custom-title search) |

The `initialEnrichCount` defaults are 50 wherever the parameter is optional.
Callers pass no `limit`, no `initialEnrichCount` and no `options` today; the
picker continues a progressive listing itself with `enrichLogs(allStatLogs,
nextIndex, …)`.

**Structure constraints:**
- The two byte walkers must not import the barrel or anything that needs bootstrap state: the resume loader imports them, and the barrel imports the loader.
- The listings use the session-file helpers of `src/sessions/indexing/liteMetadata.ts` (`getSessionFilesLite`, `enrichLogs`, `deduplicateLogsBySessionId`), which are not this unit. What those helpers decide (the stat-only entry, which fields a read fills, which sessions it hides) is described below only as far as these listings show it.

## Observable behaviour

### 1. Pre-boundary metadata: `scanPreBoundaryMetadata(filePath, endOffset)`

- **The range.** Only bytes `0 … endOffset - 1` of the file are read. A byte at `endOffset` or later never shows up, even when it would complete a marker (pinned at the exact byte).
- **What comes back.** Every line in that range that carries one of exactly ten session-metadata kinds, in file order, as a string without its newline. A kind is recognised by the compact bytes `"type":"<kind>"` on the line:
  `summary`, `custom-title`, `tag`, `agent-name`, `agent-color`, `agent-setting`, `mode`, `worktree-state`, `cost-state`, `pr-link`.
  These are the kinds the resume loader restores from that range, and no others.
- **What does not.** Message lines, and every other entry kind: `ai-title`, `last-prompt`, `task-summary`, `file-history-snapshot`, `attribution-snapshot`, `queue-operation`, compact boundaries.
- **Line ends.** A last line without a newline is still a line. So when `endOffset` falls inside a line, the part before it is that line, and it comes back if the part carries a marker.
- **Where a line falls does not matter.** A metadata line is found whether it starts at the beginning of the file, right after a message line hundreds of KiB long, or anywhere around a 64 KiB or 128 KiB offset; a metadata line of a few KiB that crosses such an offset comes back whole.
- **Past the end.** An `endOffset` beyond the file reads the whole file.
- **No parsing.** Lines are matched as bytes and returned as text; nothing is parsed or validated. The caller parses them and dispatches on the top-level `type`.

### 2. Dropping dead branches: `walkChainBeforeParse(buf)`

The buffer is JSONL as the transcript writer emits it. A **message line** is one
that starts with the bytes `{"parentUuid":` and has a `"uuid":"<36 characters>"`
member. Its parent is `null`, or the 36 characters after `{"parentUuid":"`.
Every other line is a **metadata line**, including a line that starts with
`{"parentUuid":` but has no `"uuid":"` member.

- **The leaf** is the last message line that does not contain the bytes `"isSidechain":true`. A line with no `isSidechain` member at all is a leaf candidate, even when the next line is a sidechain line.
- **The chain** is the leaf and its ancestors, followed by parent uuid. It ends at a `null` parent, at a parent that no line in the buffer has, or when a uuid repeats (a parent cycle ends the walk; it does not hang).
- **Which uuid is the message's own.** The writer places the top-level `uuid` right before `"timestamp"`. A line can hold other `"uuid":"…","timestamp":"…"` pairs inside nested values: a progress entry carries a nested message before its own uuid, and a tool result can carry a server-supplied record after it. The top-level one is always the one taken. String contents never count as nesting: braces, escaped quotes and a string ending in a backslash are pinned. A line whose uuid is its last member (no timestamp after it) is still linked by that uuid.
- **The result.** Every metadata line and every chain message line, with their bytes unchanged and in their original order. The messages off the chain are dropped, sidechain lines included. A last line without a newline stays without one.
- **When nothing is dropped.** The bytes come back as given when:
  - there is no leaf (no message lines, or only sidechain ones; an empty buffer included);
  - the bytes off the chain, **metadata lines included**, are less than half the buffer length rounded down. At exactly half, or at half rounded down for an odd length, the cut happens (both edges pinned).
- **The input buffer is never modified.**

### 3. Stat-only listing of a repository: `getStatOnlyLogsForWorktrees(worktreePaths, limit?)`

- **One worktree or none.** The paths passed are ignored. The listing is the sessions of the project folder of the **original cwd** (`<config home>/projects/<sanitizePath(original cwd)>`), each with `projectPath` set to the original cwd.
- **Several worktrees.** Every folder directly under `<config home>/projects/` whose name equals a worktree's sanitized path, or starts with it followed by `-`, is listed. That takes in the folders of sessions started in a subdirectory of a worktree (`/repo/app/packages/api`), and leaves out names that only share a prefix (`/repo/application` for `/repo/app`).
  - **The longest match wins.** A folder belonging to several worktrees is attributed to the worktree with the longest sanitized path, whatever order the worktrees came in. Its sessions get that worktree's path as `projectPath`.
  - **Case.** Names are compared exactly, except on Windows, where both sides are lowercased (a drive letter written `C:` in the worktree list matches a folder stored as `c--…`).
  - **No projects folder.** Nothing is listed.
  - **The same session in two folders** is listed once: the entry whose file was modified last.
- **A session** is a file `<uuid>.jsonl` directly in a listed folder. Other names, other extensions and subdirectories are not sessions.
- **The entry** is built from `stat` alone, without reading the file: `date` (the modification time, ISO), `messages: []`, `isLite: true`, `fullPath`, `created` (birth time), `modified` (modification time), `firstPrompt: ''`, `messageCount: 0`, `fileSize`, `isSidechain: false`, `sessionId`, `projectPath`, and `value`.
- **Order.** Newest modification first (creation time breaks ties), and `value` counts 0, 1, 2 … in that order.

### 4. Same-repository listing: `loadSameRepoMessageLogsProgressive(worktreePaths, limit?, initialEnrichCount = 50)`

- `allStatLogs` is the listing of section 3 for the same worktrees.
- `logs` holds the first sessions of that listing that are worth showing, read for their metadata, up to `initialEnrichCount` of them. Reading walks the listing from the top; a sidechain session or a team session is read and skipped. Each shown entry has `isLite: false` and the fields `enrichLogs` fills from the head and tail of the file: the first prompt, the custom title, the git branch, and `projectPath` from the transcript's own `cwd` when it has one.
- `logs[i].value` is `i`.
- `nextIndex` is the position in `allStatLogs` where reading stopped: the number of entries read, skipped ones included. The picker passes it back to `enrichLogs` to load more.
- **`loadSameRepoMessageLogs(…)`** returns just the `logs` of the same call.

### 5. All-projects listing: `loadAllProjectsMessageLogsProgressive(limit?, initialEnrichCount = 50)`

- Every folder directly under `<config home>/projects/` is listed, with the session rules of section 3. Plain files there are ignored.
- `limit` keeps the newest `limit` sessions **of each folder**.
- The same session in two folders is listed once, from the file modified last; `allStatLogs` is sorted newest first with `value` counting from 0.
- `logs` and `nextIndex` follow section 4.
- With no projects folder: `{ logs: [], allStatLogs: [], nextIndex: 0 }`.
- **`loadAllProjectsMessageLogs(limit?, options?)`** returns the `logs` of the same listing, with `options.initialEnrichCount` (default 50). With no projects folder it returns `[]`.

### 6. Agent sidecars: `writeAgentMetadata`, `readAgentMetadata`

- **Where.** Beside the agent's transcript: the path of `getAgentTranscriptPath(agentId)` with `.jsonl` replaced by `.meta.json`. That is `<session folder>/<session id>/subagents/[<subdir>/]agent-<agentId>.meta.json`, so it follows the agent's transcript subdirectory (`setAgentTranscriptSubdir`) and the folder a resumed session was switched into.
- **The format** is `JSON.stringify` of the object given: compact, members in the order given, no newline at the end. `src/sessions/indexing/__fixtures__/rewrite/agent.meta.json` is a full one.
- **Writing** creates the missing folders and replaces the whole file. A field left out of a later write is gone, which is how `AgentTool` clears `worktreePath` after removing an agent's worktree.
- **Reading** returns the stored object as it is. A sidecar from an older build with only `agentType` reads back with only `agentType`.
- **Missing.** When the sidecar does not exist, or a component of its path is not a folder, reading returns `null`.

### 7. `sessionIdExists(sessionId)`

- True when `<config home>/projects/<sanitizePath(original cwd)>/<sessionId>.jsonl` exists, even empty; false otherwise.
- Only that folder counts. A transcript of the same id in another project folder, or in the folder the current session was switched into on resume, does not.
- The config home is read at every call.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `scanPreBoundaryMetadata` on a missing file | rejects with `ENOENT` |
| `scanPreBoundaryMetadata` with `endOffset` 0 | rejects with a `RangeError` today; finding 4. Not pinned |
| `scanPreBoundaryMetadata` on a message line that holds a marker inside a nested value | may come back with the metadata, depending on where it falls; finding 3. Not pinned |
| a metadata line longer than about 64 KiB | may be lost or come back in part; finding 3. Not pinned |
| `walkChainBeforeParse` on an empty buffer | an empty buffer |
| a parent cycle in the chain | the walk stops; both messages are kept |
| a duplicated uuid | the later line is the one on the chain. Not pinned |
| a main-thread line holding `"isSidechain":true` inside a nested value | treated as a sidechain line; finding 5. Not pinned |
| `getStatOnlyLogsForWorktrees` with `limit` | ignored with one worktree or several, applied only when the projects folder cannot be read; finding 1. Not pinned |
| an unreadable session folder | listed as empty |
| `readAgentMetadata` on a sidecar that is not valid JSON, or is a directory | rejects; finding 6. Not pinned |
| `sessionIdExists` after `/resume` switched the session folder | false for the current session; finding 7 |

## Security requirements

**Pinned by the tests:**
- **No parse on the hot path.** Neither walker parses a line. The pre-boundary scan returns text for the caller to parse, and the chain walk decides on bytes only. Large tool outputs never reach `JSON.parse` here; the suite runs a 300 KiB message line through the scan.
- **Server-supplied records cannot redirect the chain.** A tool result can hold any record a server returns, including one shaped like `{"uuid":"…","timestamp":"…"}`. Only the top-level uuid of a line links it into the chain, so such a record cannot make the walk keep a dead branch or drop live history. The suite pins records before and after the top-level uuid, and strings with braces and escapes.

**Not pinned:**
- **Path components are joined as given.** `sessionIdExists` joins its argument into a path, and the sidecar path takes the agent id. Today the callers keep this safe: `--session-id` goes through `validateUuid` first, the exit hint passes the current session id, and agent ids are generated (`createAgentId`). The rewrite should not widen that: take the id types the callers already have.

## Tests that pin it

- **The characterization suite, 68 tests in three files.** Coverage of the old code: `agents.ts` 100% of lines, `boundaryScan.ts` 99.6%, `crossProject.ts` 76.3% (the rest is the `skipIndex` path, see Out of scope).
  - **`src/sessions/indexing/indexingScan.boundaryScan.characterization.test.ts`** (35): both walkers. The chain-walk cases are a table of line lists and the lines that must survive. The scan runs on real files in a fresh temp directory per test, with metadata lines shifted across the 64 KiB and 128 KiB offsets.
  - **`src/sessions/indexing/indexingScan.crossProject.characterization.test.ts`** (16): the listings, on real transcripts in a fresh `CLAUDIN_CONFIG_DIR` per test, with modification times set so the order is known. The Windows case switches `process.platform` for one call and restores it.
  - **`src/sessions/indexing/indexingScan.agents.characterization.test.ts`** (17): the sidecars and `sessionIdExists`, through the barrel, on a fresh config home and cwd per test. The bootstrap session state it moves is restored.
- **The fixtures, in `src/sessions/indexing/__fixtures__/rewrite/`.** They are laid out the way the transcript writer lays out lines, and the expected files come from an independent oracle: every line parsed, the chain followed from the last main-thread message.
  - `forked.input.jsonl` and `forked.walked.jsonl`: a rewound session with a fat dead branch, a progress entry with a nested message, a tool result with a nested record, a sidechain line and metadata throughout.
  - `pre-boundary.jsonl` and `pre-boundary.metadata.jsonl`: each of the ten kinds once among messages and the other entry kinds, then a compact boundary and a tag after it.
  - `agent.meta.json`: a full sidecar.
- **The probe spec, `scripts/migrations/probes/rewrite-sessions-indexingScan.json`.** 40 probes over the three files. Every one turns the suite red.
- **Existing tests,** this project's own, which stay and must keep passing:
  - `src/sessions/__tests__/barrelExports.test.ts`, with its snapshot: the barrel's names.
  - `src/sessions/sessionRestore.costState.test.ts`: a cost stamp written before the boundary of a transcript over 5 MiB is recovered through the pre-boundary scan.
- **Model-facing text.** The unit sends none to a model, so no prompt snapshot depends on it.
- **Not pinned, and why:**
  - **Behaviour that findings 1 and 3 to 6 change,** so that the suite passes on both the old and the new code.
  - **Two folders that differ only in case, on Windows.** Only one of them is listed today. A Linux temp directory can hold both, but the order they are read in is not fixed, so which one is listed cannot be pinned.

## Out of scope

- **The `skipIndex` option of `loadAllProjectsMessageLogs`.** It loads and parses every transcript of every project, one entry per conversation leaf, deduplicated by session and leaf. No caller passes it, so drop the option and its path. Coverage of the old `crossProject.ts` stops at 76% because of it.

## Findings

1. **`limit` is ignored by the same-repository listing.** With one worktree or several, every session is listed; only the fallback for an unreadable projects folder applies it. The all-projects listing applies it per folder. **Decision: fix.** Apply it per folder everywhere, as the all-projects listing does. No caller passes it. Not pinned.
2. **A sibling project can list as a worktree's.** A folder is matched to a worktree by its sanitized name followed by `-`, which is how sessions started in a subdirectory are found. `/repo/app/legacy` and a separate checkout at `/repo/app-legacy` sanitize alike, so the second lists under `/repo/app` too. **Decision: keep for parity.** The folder name is all there is to go on (the storagePure spec, finding 9), and dropping the rule would hide every session started in a subdirectory. Pinned through the subdirectory case.
3. **The pre-boundary scan matches markers anywhere on a line, and is unreliable on very long lines.** A message line that holds a marker inside a nested value may come back, and a line longer than about 64 KiB may be lost or come back cut, depending on where it falls. **Decision: keep for parity.** The caller parses what comes back and keeps only lines whose top-level `type` is one of the ten, so extra lines and fragments cost nothing; the writer emits metadata lines well under 1 KiB. Not pinned either way.
4. **An `endOffset` of 0 rejects with a `RangeError`.** **Decision: fix.** Return `[]`: the range is empty. The loader never passes 0. Not pinned.
5. **A nested `"isSidechain":true` hides a leaf.** The leaf test looks at the whole line, so a main-thread message that holds those bytes inside a nested value (a tool result record, say) is taken for a sidechain line. If it is the last main-thread message, an earlier message becomes the leaf and the live tail is dropped before parsing. **Decision: fix.** Only the top-level member counts. Nothing depends on the misreading. Not pinned.
6. **An unreadable sidecar fails the resume.** `readAgentMetadata` rejects when the sidecar is not valid JSON (empty or cut short: the write is not atomic) or is a directory, and the agent's resume fails with that error, though the metadata is optional and older agents have none. It also returns any JSON value without checking that it is an object. **Decision: fix.** Read anything that is not a JSON object with a string `agentType` as `null`, and write the sidecar atomically. Not pinned.
7. **`sessionIdExists` looks only in the original cwd's folder.** That is right for `--session-id`, which refuses an id already used there. The exit hint asks about the current session, whose transcript is in the switched folder after `/resume` of a session from another worktree, so the hint is not printed then. **Decision: keep for parity** in this unit; the exit hint should check the current transcript path instead, which is a change to `gracefulShutdown.ts`, not here. Pinned.

## Target design

- **Two pure byte modules.** The chain walk is a pure function over a buffer. The pre-boundary scan is a line splitter over a bounded file range feeding a pure line classifier. Neither imports bootstrap state or the barrel, and neither parses JSON.
- **One line classifier** for the scan: a line is metadata when its top-level `type` is one of the ten kinds, held as an explicit `ReadonlySet` of the kind names. Finding 3 then has one place to tighten, and finding 4 is an empty range.
- **One message-line reader** for the walk: it yields the top-level uuid, the parent and the sidechain flag of a line, string- and nesting-aware. Finding 5 is then the same rule as the uuid one.
- **The listings as composition.** Folder discovery (all folders, or those matching the worktrees by longest sanitized prefix), the stat-only listing per folder, deduplication by session id, and the first read are separate functions. The `limit` applies in the per-folder listing in every path (finding 1).
- **Sidecars as a small module** with an explicit `AgentMetadata` shape check on read and an atomic write (finding 6).
- **Explicit types.** No `any`, no casts of parsed JSON without a check, regexes at module level. The only errors swallowed are the documented ones: a missing sidecar, an unreadable session folder, a missing projects folder.
- **Call-time reads.** The config home, the original cwd, the session id and folder, and `process.platform` are read at call time, because the tests change them between calls.
