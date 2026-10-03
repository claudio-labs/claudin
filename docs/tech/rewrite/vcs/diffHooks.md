# Spec: `vcs/diffHooks`

Four files: `src/vcs/diff/hooks/useDiffInIDE.ts`, `useTurnDiffs.ts` and
`useDiffData.ts`, and `src/vcs/hooks/usePrStatus.ts`.

## Purpose

The React-side data sources of the vcs slice's screens, in four parts:

- **The IDE diff** (`useDiffInIDE`). While the file permission dialog asks whether a file edit or write may go ahead, the proposed change can be shown as a diff tab in the connected IDE. The user's action in the IDE (save, close, reject) becomes the dialog's decision.
- **Per-turn diffs** (`useTurnDiffs`). For the `/diff` reviewer's per-turn sources: which files the tools of each user prompt changed, with their hunks. The source is the transcript.
- **The reviewer's file list** (`gitDiffResultToFiles` in `useDiffData.ts`). It turns a repository's diff numbers and hunks into the rows of the reviewer's Local Changes tab and of the `/explorer` change tint.
- **The PR pill** (`usePrStatus`). The pull or merge request of the current branch, polled from the code host's CLI (`gh`, `glab` or `tea`) for the prompt footer and the branch segment.

`docs/features/8.1-diff-reviewer.md` describes the reviewer these feed. What it
promises that this unit carries:
- the per-turn sources, newest first, labelled `T<n>`;
- the 400-line cap on a file's diff (the `(truncated)` title);
- the "Large file - diff exceeds 1 MB limit" placeholder;
- untracked files listed without hunks, which the reviewer then builds itself;
- a turn's sources following the agent: the reviewer hands the hook a new transcript at every turn end.

## Public contract

`Hunk` stands for `StructuredPatchHunk` from the `diff` package. Every name
below keeps its name and type while modules not yet rewritten import it.

**`useDiffInIDE.ts`**

| Export | Signature | Used by |
|---|---|---|
| `useDiffInIDE` | one props object: `onChange(option: PermissionOption, input: { file_path: string; edits: FileEdit[] }): void`, `toolUseContext: ToolUseContext`, `filePath: string`, `edits: FileEdit[]`, `editMode: 'single' \| 'multiple'`. Returns `{ closeTabInIDE: () => void; showingDiffInIDE: boolean; ideName: string; hasError: boolean }` | `src/permissions/ui/FilePermissionDialog/FilePermissionDialog.tsx` |
| `computeEditsFromContents` | `(filePath: string, oldContent: string, newContent: string, editMode: 'single' \| 'multiple') => FileEdit[]` | no importer outside the unit; it may stop being exported |

`closeTabInIDE` is typed `() => void`, but it returns a promise that resolves
to `undefined`. The dialog calls it without waiting.

**`useTurnDiffs.ts`**

| Export | Signature | Used by |
|---|---|---|
| `TurnFileDiff` (type) | `filePath: string`, `hunks: Hunk[]`, `isNewFile: boolean`, `linesAdded: number`, `linesRemoved: number` | the unit's own types |
| `TurnDiff` (type) | `turnIndex: number`, `userPromptPreview: string`, `timestamp: string`, `files: Map<string, TurnFileDiff>`, `stats: { filesChanged: number; linesAdded: number; linesRemoved: number }` | `src/vcs/diff/ui/DiffDialog.tsx`, `src/vcs/diff/ui/types.ts` |
| `useTurnDiffs` | `(messages: Message[]) => TurnDiff[]` | `DiffDialog.tsx` |
| `applyToolResultToTurn` | `(turn: TurnDiff, result: unknown) => void` | `useTurnDiffs.test.ts` |
| `isApplyPatchResult` | `(result: unknown) => result is { files: ApplyPatchFileResult[] }` | `useTurnDiffs.test.ts` |
| `mergeFileDiff` | `(turn: TurnDiff, filePath: string, hunks: Hunk[], isNewFile: boolean) => void` | `useTurnDiffs.test.ts` |

**`useDiffData.ts`**

| Export | Signature | Used by |
|---|---|---|
| `DiffFile` (type) | `path: string`, `linesAdded: number`, `linesRemoved: number`, `isBinary: boolean`, `isLargeFile: boolean`, `isTruncated: boolean`, optional `isNewFile`, `isUntracked` (booleans) and `renamedFrom` (string) | `DiffDialog.tsx`, `DiffFileList.tsx`, `src/vcs/diff/ui/fileTree.ts`, `types.ts`, `src/terminal/explorer/ExplorerDialog.tsx`, `src/terminal/explorer/tree.ts`, and three of their tests |
| `gitDiffResultToFiles` | `(diffResult: GitDiffResult, hunks: Map<string, Hunk[]>) => DiffFile[]` | `src/vcs/diff/hooks/useWorkspaceDiff.ts`, `useDiffData.test.ts` |
| `DiffData` (type), `useDiffData` | `(cwd?: string) => DiffData` | none (finding 1) |

**`usePrStatus.ts`**

| Export | Signature | Used by |
|---|---|---|
| `PrStatusState` (type) | `number: number \| null`, `url: string \| null`, `reviewState: PrReviewState \| null`, `label: PrLabel \| null`, `lastUpdated: number` | the return type below |
| `usePrStatus` | `(isLoading: boolean, enabled?: boolean) => PrStatusState`, where `enabled` defaults to `true` | `src/terminal/prompt-input/PromptInputFooterLeftSide.tsx`, `src/vcs/hooks/useCwdBranchSegment.ts` |

`PrReviewState` and `PrLabel` are declared in `src/vcs/git/ghPrStatus.ts`,
which asks the code host (outside the unit).

## Observable behaviour

### 1. `useDiffInIDE`: a proposed edit as an IDE diff tab

- **When the diff goes to the IDE.** All three must hold. Otherwise nothing is sent to the IDE, `onChange` is never called, and `showingDiffInIDE` is `false`.
  - The session's MCP servers (`toolUseContext.options.mcpClients`) include a connected one named `ide`. A server with another name, or an `ide` entry that is pending or failed, does not count.
  - The global config's `diffTool` is `'auto'`, which is the default. `'terminal'` keeps the diff in the terminal.
  - The path does not end in `.ipynb`.
- **Once per mount.** The IDE is asked once, when the hook mounts. New props later (the dialog builds a new props object on every render) do not ask again.
- **The request.** One `openDiff` tool call to the IDE server, with exactly four arguments:
  - `old_file_path` and `new_file_path`: both the file's absolute path. A relative path is resolved against the session's working directory, and `~` against the home directory. Under WSL, with an IDE that runs on Windows and `WSL_DISTRO_NAME` set, both are converted to the IDE's Windows form (not pinned).
  - `new_file_contents`: the file's current text with the edits applied in order, by the edit tool's rules: the first occurrence, or every occurrence with `replace_all`. The text is read with CRLF turned into LF, so the proposal has LF endings. A file that does not exist counts as empty.
  - `tab_name`: `✻ [Claudin] <name> (<6 hex digits>) ⧉`. `<name>` is the last component of the path, and the six lowercase hex digits are random for each mount. The same name closes the tab later.
  - The file on disk is not changed.
- **The answer.** The IDE answers `openDiff` when the user acts in the editor. Only the text of its content blocks counts.

  | First block | Reported through `onChange` |
  |---|---|
  | `FILE_SAVED`, with a second text block | `{ type: 'accept-once' }`, with edits rebuilt from the file's text to the second block's text. When the two are identical, `{ type: 'reject' }` with the edits as proposed. |
  | `TAB_CLOSED` | `{ type: 'accept-once' }`, with edits rebuilt from the file's text to the proposal: closing the tab accepts it |
  | `DIFF_REJECTED` | `{ type: 'reject' }`, with the edits as proposed |
  | anything else, no content, a second block missing after `FILE_SAVED`, structured content, a tool error | nothing; `hasError` becomes `true` |

  - `input.file_path` is the `filePath` prop as given: relative stays relative.
  - After every answer, recognised or not, the hook sends `close_tab` with `{ tab_name }` for that tab at least once (finding 9).
- **Rebuilt edits.** Every rebuilt edit has `replace_all: false`. Its `old_string` and `new_string` are runs of whole lines joined with `\n`.
  - `single` mode: one edit covering the whole file.
  - `multiple` mode: one edit per changed region. Each carries up to 3 unchanged lines of context on each side, and regions whose context overlaps merge, like the hunks of a unified diff with 3 lines of context.
  - How the file's final newline is handled is finding 3.
- **The returned object.**
  - `showingDiffInIDE`: whether the diff went to the IDE. It turns `false` once `hasError` is `true`.
  - `hasError`: `false` until the IDE flow fails (see errors).
  - `ideName`: the configured `ideName` of the IDE connection, for the IDE transports `ws-ide` and `sse-ide`. Otherwise it is the name `src/platform/ide/ide.ts` gives the terminal the session runs in, when that is an IDE's terminal, and `'IDE'` when it is not.
  - `closeTabInIDE()`: sends `close_tab` for this mount's tab when an IDE connection is present. Either way it returns a promise that resolves to `undefined` and never rejects. The dialog calls it whenever the user answers in the terminal.
- **While the tab is open.** Aborting the tool call (`toolUseContext.abortController`) closes the tab, and so does the process's `beforeExit`. Both stop applying once the IDE has answered or the flow has failed.
- **After unmount,** an answer from the IDE reports nothing.

### 2. `useTurnDiffs(messages)`: files changed per user prompt

- **Turns.** Every user message that is neither a tool result nor meta starts a turn, numbered from 1 in transcript order. A tool result is a message carrying a tool-result object, or a message whose first content block is a `tool_result`.
  - Turns without a changed file are left out of the result, but they keep their number, so the numbers can skip.
  - The result is newest first.
  - An interruption notice is a user text message and starts a turn (finding 6).
  - Assistant, system and attachment messages, meta user messages, and tool results that change no file change nothing.
  - A tool result that comes before the first prompt is ignored.
- **A turn** is `{ turnIndex, userPromptPreview, timestamp, files, stats }`:
  - `userPromptPreview`: a string prompt of up to 30 characters as it is; a longer one as its first 29 characters followed by `…`. A prompt given as content blocks has an empty preview (finding 6).
  - `timestamp`: the prompt message's `timestamp`.
  - `files`: one entry per path, in the order the turn first touched it.
  - `stats`: the number of files, and the sums of their `linesAdded` and `linesRemoved`.
- **Which tool results change files,** and how:
  - **Edit or write**, a result with a `filePath`:
    - a non-empty `structuredPatch` adds its hunks to that path;
    - a result with `type: 'create'` and string `content` and an empty patch adds one all-added hunk: `oldStart` 0, `oldLines` 0, `newStart` 1, `newLines` the number of lines, each line `+` followed by the line text (finding 4);
    - such a created file is `isNewFile: true`, and stays new when later results in the turn edit it;
    - a result with an empty patch and no created content changes nothing.
  - **Apply-patch**, a result `{ files: [...] }` where every entry has a string `absPath` and a `structuredPatch` array:
    - each entry adds its hunks to its path;
    - a `move` with a `movePath` is filed under the destination, not the source;
    - an `add` is new;
    - a `delete` is filed under its path with its removed lines;
    - if a single entry is malformed, the whole result is ignored.
  - **The same path touched again** in a turn gets its hunks appended in order, and its counts added.
  - **Counting.** `linesAdded` counts the hunk lines starting with `+`, and `linesRemoved` the lines starting with `-`. `\ No newline at end of file` markers and context lines count for neither.
- **As the transcript changes:**
  - A longer transcript that extends the previous one adds to the running turn and adds new turns.
  - A shorter one (a rewind or a clear) is read again from the start, and the numbering starts over.
  - A list with the same messages gives the same turns. What a replaced, equally long list gives is finding 5.
  - Callers must not rely on turn object identity across renders.

### 3. `gitDiffResultToFiles(result, hunks)`: the reviewer's file list

One `DiffFile` per entry of `result.perFileStats` (vcs/gitDiff section 1),
sorted by path with `localeCompare`. That is case-insensitive order (`a.ts`,
`B.ts`, `big.ts`), not git's byte order.

- **Numbers.** `path` is the key, `linesAdded` is `added`, `linesRemoved` is `removed`, and `isBinary` is carried over.
- **`isUntracked`** is always present: `true` for an untracked entry, `false` otherwise.
- **`renamedFrom`** is present only for a rename, with the old path. Otherwise the key is absent.
- **`isNewFile`** is never set here.
- **`isLargeFile`** is true for a file that is neither binary, untracked nor renamed and has no entry in `hunks`. That covers:
  - every such file when the hunks could not be fetched, the 1,000,000-byte case of vcs/gitDiff (finding 4 there), small files included;
  - a mode-only change and an empty new file, which have no hunks (vcs/gitDiff finding 16, kept for parity).
- **`isTruncated`** is true when a file is neither large nor binary and `added + removed` is above 400. At exactly 400 it is `false`.
- **An empty result** gives an empty list.

### 4. `usePrStatus(isLoading, enabled)`: the PR pill

- **The state.**
  - It starts, and stays while nothing is known, as `{ number: null, url: null, reviewState: null, label: null, lastUpdated: 0 }`.
  - An answer that changes `number`, `reviewState` or `label` replaces the state, with `lastUpdated` set to `Date.now()` at that moment. An answer that changes none of the three keeps the very same state object (finding 7).
  - A pill that goes away (merged, closed, no pull request any more) empties the state, and the empty state is stamped too, so `lastUpdated` is no longer 0.
- **What is asked, and where.** The hook asks `src/vcs/git/ghPrStatus.ts`, which runs the code host's CLI in the session's working directory. It runs nothing outside a git repository, on the default branch (as `src/vcs/git/git.ts` reports it), or for a host configured as `none`. The CLI, from the `origin` remote's host:

  | Host | Command |
  |---|---|
  | `github.com` | `gh pr view --json number,url,reviewDecision,isDraft,headRefName,state` |
  | `gitlab.com` | `glab mr view -F json` |
  | `codeberg.org` | `tea pr list -o json --state open --limit 100 --fields index,state,head,url,title` |
  | listed in the global config's `prStatusHosts` | that entry's CLI (`github` gh, `gitlab` glab, `gitea` tea). The config wins over the three hosts above. |
  | any other host | first probes `gh repo view --json nameWithOwner`, `glab mr list -F json` and the `tea` list above, in parallel, then asks through the one that recognises the repository. Which one wins when several do (gh, then glab, then tea) and that the choice is kept for the session are `ghPrStatus.ts`'s rules, not pinned here. |

- **Reading the answer.** The JSON on stdout counts whatever the exit status.
  - `gh`: `number`, `url` and label `PR`. The review state is `draft` for a draft, else `approved` for `APPROVED`, `changes_requested` for `CHANGES_REQUESTED`, and `pending` otherwise.
  - `glab`: `iid`, `web_url` and label `MR`. The review state is `draft` for a draft, `approved` when `approvals_left` is 0, and `pending` otherwise.
  - `tea`: the open entry whose head is the current branch, with `index` (a number or a numeric string), `url`, and label `PR`. The review state is `draft` for a draft and `pending` otherwise.
  - These leave the pill empty: no output, output that is not JSON, a merged or closed pull request, and one whose head is the default branch.
- **When it asks.**
  - With `enabled` false it never asks, and it keeps the state it had.
  - On mount, and whenever `isLoading` or `enabled` changes while enabled, it asks at once when 2 s or more have passed since the previous answered ask of this hook began. Otherwise it asks when those 2 s are up. An ask still in flight does not count, so a re-run during the very first ask starts a second one at once, and only the second one's answer is kept.
  - After each answer it asks again 2 s later.
  - **Idle.** A timed ask is skipped, and polling stops, when the session's last interaction time has not changed since the previous ask and at least 60 minutes of wall-clock time have passed since it last changed. The interaction time is `getLastInteractionTime()` from `src/platform/bootstrap/state.ts`. Exactly 60 minutes stops it. Nothing is left scheduled. The next change of `isLoading` or `enabled` starts polling again, and the first ask of a restart is never skipped as idle.
  - **Slow answers.** An ask that took more than 4 s is still shown, and then this hook instance never asks again, even when `isLoading` or `enabled` change. One that took 3.2 s keeps it polling. How the duration is measured is finding 8.
  - An answer to an ask that a re-run or an unmount superseded is dropped.
  - After unmount it never asks again.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| IDE: the edits do not apply to the file (`old_string` not found) | no `openDiff`; `hasError` `true`, `showingDiffInIDE` `false`; no decision |
| IDE: the path cannot be read as a file (a directory, no permission) | nothing sent to the IDE; `hasError` `true` |
| IDE: an empty path (a tool with no IDE diff) | no `openDiff` (finding 2) |
| IDE: an answer it does not recognise, or the IDE tool fails | the tab is closed; `hasError` `true`; no decision, so the terminal dialog decides |
| IDE: the IDE answers after the dialog unmounted | no decision |
| IDE: the IDE never answers | the tab stays open, and the dialog decides in the terminal and closes it (finding 10) |
| Turns: malformed tool results, unknown tools | ignored |
| File list: the hunks request gave nothing | every tracked text file that is not renamed is `isLargeFile` |
| PR: the CLI is missing, fails, or prints nothing | the pill stays empty |
| PR: an ask takes more than 4 s | the answer is shown, then no more polling for this instance |
| PR: an hour without interaction | polling stops until `isLoading` or `enabled` changes |
| PR: a CLI call that never ends | limited to 5 s (3 s for a probe) by `ghPrStatus.ts`; not pinned |

## Security requirements

- **The IDE's answer is a permission decision.** `TAB_CLOSED`, and `FILE_SAVED` with changed text, approve the edit once. With `FILE_SAVED` the tool then writes what the IDE returned, which the user may have edited.
- **The IDE path fails closed.** Anything unrecognised, and every error, reports no decision and leaves the choice to the terminal dialog. Keep it that way.
- **Only the connected `ide` server is trusted.** Only it is asked, and only its answers count. The hook sends it the file's absolute path and the whole proposed text.
- **The forge CLIs.** They run by bare name from `PATH`, without a shell, with fixed arguments.
  - The only input that varies is which CLI runs. It comes from the repository's `origin` URL and the user's global config.
  - They run in the session's directory every 2 s while the session is active. Being git front-ends, they read that repository's configuration, the same exposure Claudin's own git calls have. The idle stop keeps an abandoned terminal from polling forever.

## Tests that pin it

- **The suites.** 91 tests, all passing unchanged against the old module (3 runs in a row).

  | Suite | Tests | What it pins |
  |---|---|---|
  | `src/vcs/diff/hooks/useDiffInIDE.characterization.test.tsx` | 32 | section 1, against a real MCP server that plays the IDE extension, connected through the SDK's in-memory transport |
  | `src/vcs/diff/hooks/useTurnDiffs.characterization.test.tsx` | 26 | section 2, with transcripts built by the real message factories and real patches |
  | `src/vcs/diff/hooks/useDiffData.characterization.test.ts` | 3 | section 3, against real repositories read with the real `fetchGitDiff` and `fetchGitDiffHunks` |
  | `src/vcs/hooks/usePrStatus.characterization.test.tsx` | 30 | section 4. Stand-in `gh`, `glab` and `tea` sit first on `PATH` and log their directory and arguments, in real repositories on a feature branch. |

- **Harness.** Every hook runs inside a real Ink root on `src/terminal/__testutils__/fakeTerminal.ts`, through `src/vcs/diff/hooks/__testutils__/hookHost.tsx`. The git repositories come from `src/vcs/git/__testutils__/scratchRepos.ts`, and git's global and system configuration is shut out by `isolatedGitEnv.ts`.
- **Time.** The 2 s cadence, the re-run spacing and the 4 s limit are measured in real time, so they hold whatever clock the rewrite uses for durations. The idle hour and `lastUpdated` are reached by freezing `Date` (`setSystemTime`), which pins them to the wall clock.
- **Process state.** The suites set the session's working directory, `PATH`, `HOME` and `CLAUDIN_CONFIG_DIR`, and put each one back. They also clear the process-wide "is the session in a repository" cache before and after, since it is judged once per process.
- **The wire formats are pinned in the assertions, not in fixture files:**
  - the IDE tool names (`openDiff`, `close_tab`), their argument names, and the answer words;
  - the forge CLI argument lists and the reply fields.

  No real IDE or authenticated forge CLI is available to capture from, so the replies are written in each CLI's documented JSON shape.
- **`scripts/migrations/probes/rewrite-vcs-diffHooks.json`:** 40 probes over the four files, and every one turns the suites red.
- **Existing tests that stay** (this project's own): `src/vcs/diff/hooks/useTurnDiffs.test.ts` (the three exported helpers) and `useDiffData.test.ts` (`gitDiffResultToFiles` on hand-built results).
- **Prompt text pinned elsewhere:** none. The unit sends no text to a model.
- **Not pinned, and why:**
  - the WSL path conversion, because the platform is detected once per process from `/proc/version`;
  - `~` expansion, which belongs to the path helper;
  - the `'IDE'` name fallback, which is pinned only as far as the environment allows, because the terminal-derived name is fixed once per process from the environment;
  - the CLI time limits, which belong to `ghPrStatus.ts`;
  - the defects marked "fix" below, on purpose. The suites avoid their inputs, or assert only what holds either way.

## Out of scope

- **The `useDiffData` hook and its `DiffData` type** (finding 1). `DiffFile` and `gitDiffResultToFiles` stay.
- **`computeEditsFromContents` as an export.** Its behaviour stays as part of section 1, but nothing outside the unit imports it.

## Findings

1. **`useDiffData` is dead.** The hook and its `DiffData` type have no caller. The reviewer and the explorer read the working tree through `useWorkspaceDiff`, which calls `gitDiffResultToFiles` itself.
   - **Decision: remove as dead.** Not pinned.
   - This is why the file's line coverage is 37%: every uncovered line is the dead hook.
2. **An empty path still runs the IDE flow.** For a tool with no IDE diff, the file permission dialog mounts the hook with an empty path and no edits. With an IDE connected and the default diff tool:
   - the hook reads the session's directory as the file, fails, logs the error and sets `hasError`;
   - each later answer in the terminal sends `close_tab` for a tab that never existed (`✻ [Claudin]  (…) ⧉`).

   **Decision: fix.** An empty path is "not shown": no read, no request, no error. The suite pins only that no diff is opened.
3. **The rebuilt edits lose the final newline.** Neither string of a rebuilt edit carries the file's final newline, and a change that touches only the final newline becomes an edit whose two strings are equal.
   - The file-write dialog takes the first edit's `new_string` as the whole new file. So accepting a file write from the IDE, by closing the tab or saving, writes the file without its final newline.
   - For an edit, a final-newline change made in the IDE is lost.
   - **Decision: fix.** In `single` mode the one edit's strings are the complete old and new texts. In `multiple` mode an edit that reaches the end of the file carries the final newline its text has. Nothing depends on the loss.
   - The suite uses texts without a final newline, where both behaviours agree.
4. **A created file counts one line too many.** A created file's content is split at `\n`, so a final newline adds an empty `+` line to its hunk and one to `linesAdded` (`a\nb\n` counts 3). An empty file counts 1.
   - **Decision: fix.** A final newline ends the last line, as `buildAddedFileHunks` (vcs/gitDiff) does, and an empty file adds no hunk and no line.
   - Not pinned: the suite's contents have no final newline.
5. **A replaced transcript is misread unless it is shorter.** Only messages past those already read are read, and the hook starts over only when the list gets shorter. A list replaced by a different one at least as long keeps the old list's turns and reads the new one from the old position. That happens after a compaction that is followed by enough new messages before the reviewer refreshes.
   - **Decision: fix.** Start over whenever the messages already read are no longer the start of the list. Not pinned.
6. **Turn numbers count more than prompts.** Any user text message that is not a tool result or meta starts a turn. That includes an interruption notice and local-command messages, so the reviewer's `T<n>` labels skip numbers and drift from the user's count of prompts. A prompt with a pasted image (block content) starts a turn with an empty preview.
   - **Decision: keep for parity.** Which messages are prompts is for the messages module to say, and no caller shows the preview (finding 11). Revisit with the reviewer's rewrite.
   - The interruption case is pinned, its empty preview included.
7. **A change of URL alone is ignored.** An answer with the same number, review state and label but another URL keeps the old URL.
   - **Decision: fix.** Compare the URL too. Not pinned.
8. **A suspended machine can stop the pill for good.** An ask's duration is measured on the wall clock. If the machine sleeps during an ask, the ask looks as long as the sleep, the hook takes it for a slow answer, and the pill stops updating for the rest of the session. The spacing rule after a re-run uses the wall clock too, so a clock set back delays the next ask by the jump.
   - **Decision: fix.** Measure an ask's duration, and the time since the last ask, on a monotonic clock.
   - The idle hour stays on the wall clock, because a sleeping machine counts as idle. The suite measures those durations in real time, so it holds either way.
9. **Extra `close_tab` requests.** A rejection closes the tab twice. Edits that do not apply to the file send `close_tab` although no tab was opened.
   - **Decision: fix.** Close once, and only a tab that was opened. The suite pins "at least one close for the opened tab".
10. **Unmounting leaves the tab open.** When the dialog goes away without an answer in either place (the permission settled elsewhere, by a hook or another client), four things stay behind until the IDE answers:
    - the IDE tab;
    - its pending `openDiff`;
    - the abort listener;
    - the `beforeExit` listener.

    The old module's own comments say it should close the tab. **Decision: fix.** Unmounting closes the tab and drops the listeners. Not pinned.
11. **Fields no caller reads.** Nothing reads `TurnDiff`'s `userPromptPreview`, `timestamp` and `stats`, or `PrStatusState.lastUpdated`. The reviewer shows `T<n>`, and the pills show number, review state, label and URL.
    - **Decision: keep for parity** while the types are the contract. Drop them when the contract is redesigned. Pinned.
12. **Outside this unit: the stash diff is empty under git 2.55.** Phase 2 filed this under `vcs/diffHooks`, but the stash reader is `fetchStashDiff` in `src/vcs/git/gitLog.ts`, behind `src/vcs/hooks/useGitStashes.ts`, and neither is one of this unit's files (vcs/gitDiff, finding 18).
    - **Decision: tracked** for the reviewer's rewrite.

## Target design

- **`useDiffInIDE`**, three parts:
  - an IDE diff session: open the tab, wait for the answer, close the tab. It is cancelled by abort, by process exit and by unmount, and closes a tab only if it opened one;
  - a pure mapping from the answer to a decision and edits;
  - a pure edit rebuilder, one text pair to `FileEdit[]` per mode, that keeps the final newline (finding 3).

  The gate (connected `ide` server, `diffTool`, notebook, non-empty path) is one pure predicate.
- **`useTurnDiffs`**, two parts:
  - a pure reducer from transcript messages to turns, in three pieces: recognise a prompt, recognise a tool result that changes files, and fold hunks into a turn;
  - a thin hook that feeds it only the new messages. It starts over whenever what it read is no longer the start of the list (finding 5).

  The three exported helpers stay while `useTurnDiffs.test.ts` imports them.
- **`useDiffData.ts`** keeps `DiffFile` and a pure `gitDiffResultToFiles`, and loses the dead hook.
- **`usePrStatus`**:
  - a small poller with explicit rules: interval, re-run spacing, idle stop on the wall clock, and the slow-answer cut-off on a monotonic clock (finding 8);
  - a pure state reducer that compares all four fields (finding 7).

  The code host logic stays in `ghPrStatus.ts`.
- **Types:** explicit, and no `any`. Keep every export of the contract table while its importers exist.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.** Eighteen inherited bodies were written anew. The IDE-diff logic
  moved into `diff/hooks/ideDiff/` (gate, proposal, edit rebuild), and the PR
  pill into `hooks/prStatus/` (pill state, poller). `SLOW_GH_THRESHOLD_MS`
  became `PILL_POLL_RULES.slowAnswerMs`, and `INITIAL_STATE` became an
  `emptyPill()` factory.
- **The `useDiffData` hook was deleted** as dead code, per finding 1. Its file
  keeps `DiffData`. Its old 37% coverage was that dead hook.
- **Callers.** Four exports outside the unit lost their last caller and were
  removed: `getEditsForPatch` in `FileEditTool/utils.ts`, the two IDE MCP
  config types in `mcp/types.ts`, and the `callIdeRpc` re-export in
  `platform/ide/ide.ts`.
- **Spec decisions.** Fixes 2–5 and 7–10 landed with tests; 6 and 11 are kept
  for parity.
- **Deviations.**
  - Closing the tab from the terminal ends the IDE session.
  - `closeTabInIDE` closes only a tab this mount opened.
- **Probes.** `rewrite-vcs-diffHooks.json`, 96 probes.
- **Residue, reviewed.** 46 lines of Claude Code remain.
  - `useTurnDiffs.ts`, 27: the `TurnFileDiff`, `TurnDiff`, `FileEditResult` and
    `TurnDiffCache` types, plus the shape of a new turn.
  - `useDiffInIDE.ts`, 14: the `Props` type and the hook's signature.
  - `useDiffData.ts`, 2, and `usePrStatus.ts`, 3: type fields.

  The two counting loops in `useTurnDiffs.ts` were reworded at landing.
