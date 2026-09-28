# Spec: `vcs/gitDiff`

Six files in `src/vcs/git/`: `gitDiff.ts`, `diff.ts`, `diffStat.ts`,
`gitStatusDelta.ts`, `commitAttribution.ts` and `attribution.ts`.

## Purpose

The diff layer of the vcs slice, in five parts:

- **Reading a repository's changes:** per-file numbers, hunks, and the one-line readout. The `/diff` reviewer and the explorer's change tint use the first two, the prompt footer the third.
- **Parsing git's text output:** unified diff, `--numstat` and `--shortstat`. The reviewer's Log and stash tabs parse their own git output with these, and so does the Git tool's diff budget.
- **Patches between two texts:** hunks for the edit, write and apply-patch tools, their permission dialogs and the IDE diff, plus two line counters (the session's lines-changed totals, and the added/removed figures of collapsed tool rows).
- **The git status snapshot,** which reaches the model once per conversation.
- **Attribution:**
  - the text added to commit messages and pull request bodies (nothing by default);
  - the per-session attribution counters kept in AppState;
  - the transcript line those counters were stored as.

## Public contract

Every name below keeps its name and type, because modules not yet rewritten
import it. `Hunk` stands for `StructuredPatchHunk` from the `diff` package.

**`gitDiff.ts`**

| Export | Signature | Used by |
|---|---|---|
| `GitDiffStats` (type) | fields `filesCount`, `linesAdded`, `linesRemoved`, all `number` | `src/vcs/diff/hooks/useDiffData.ts` |
| `PerFileStats` (type) | `added: number`, `removed: number`, `isBinary: boolean`, optional `isUntracked: boolean`, optional `renamedFrom: string` | `useDiffData.ts` and its test, `src/vcs/git/gitLog.ts` |
| `GitDiffResult` (type) | `stats: GitDiffStats`, `perFileStats: Map<string, PerFileStats>`, `hunks: Map<string, Hunk[]>` | `useDiffData.ts`, `useWorkspaceDiff.ts` |
| `NumstatResult` (type) | `stats` and `perFileStats` as above | the return type of `parseGitNumstat` |
| `fetchGitDiff` | `(cwd?: string) => Promise<GitDiffResult \| null>` | `src/vcs/diff/hooks/useWorkspaceDiff.ts` (always with a root), `useDiffData.ts` (no caller of its own) |
| `fetchGitDiffHunks` | `(cwd?: string) => Promise<Map<string, Hunk[]>>` | the same two |
| `parseGitNumstat` | `(stdout: string) => NumstatResult` | `gitLog.ts` (commit and stash file lists) |
| `parseGitDiff` | `(stdout: string) => Map<string, Hunk[]>` | `gitLog.ts` (commit and stash diffs), `src/tools/GitTool/parsers/diff.ts` |
| `buildAddedFileHunks` | `(content: string) => Hunk[]` | `src/vcs/diff/ui/DiffDialog.tsx` |
| `parseShortstat` | `(stdout: string) => GitDiffStats \| null` | the unit and its tests |
| `DiffStatSummary` (type) | `uncommitted: GitDiffStats \| null`, `branch: GitDiffStats \| null`, `branchBase: string \| null` | `src/vcs/diff/hooks/useGitDiffStat.ts` |
| `DiffStatScope` (type) | either `{ kind: 'uncommitted' }` or `{ kind: 'branch'; against: string; base: string }` | the return type of `chooseDiffStatScope` |
| `chooseDiffStatScope` | `(head: string, mergeBase: string \| null, base: string) => DiffStatScope` | `src/vcs/gitDiffStatSummary.test.ts` |
| `fetchDiffStatSummary` | `() => Promise<DiffStatSummary>` | `useGitDiffStat.ts` (the footer poll) |

**`diff.ts` and `diffStat.ts`**

| Export | Signature | Used by |
|---|---|---|
| `CONTEXT_LINES` | `3` | `src/tools/FileEditTool/UI.tsx`, `FileEditTool/ui/FileEditToolDiff.tsx` |
| `DIFF_TIMEOUT_MS` | `5_000` | `src/tools/FileEditTool/utils.ts` |
| `adjustHunkLineNumbers` | `(hunks: Hunk[], offset: number) => Hunk[]` | `FileEditTool/UI.tsx`, `FileEditToolDiff.tsx` |
| `countLinesChanged` | `(patch: Hunk[], newFileContent?: string) => void` | `FileEditTool.ts`, `FileWriteTool.ts`, `src/tools/shared/stagedWrite/stagedWrite.ts` |
| `getPatchFromContents` | one object argument with `filePath`, `oldContent`, `newContent` (strings) and optional `ignoreWhitespace`, `singleHunk` (booleans), returning `Hunk[]` | `stagedWrite.ts`, `ApplyPatchTool/applyPatch.ts`, `FileEditTool/utils.ts`, `src/vcs/diff/hooks/useDiffInIDE.ts` |
| `getPatchForDisplay` | one object argument with `filePath`, `fileContents` (strings), `edits: FileEdit[]` and an optional `ignoreWhitespace`, returning `Hunk[]` | `FileWriteTool.ts` and its UI, `FileEditTool/utils.ts`, `FileEditToolDiff.tsx`, the file-write and notebook-edit permission dialogs |
| `countAddDel` (in `diffStat.ts`) | `(hunks: Hunk[]) => { additions: number; deletions: number }` | `src/agent/tools/collapseReadSearch.ts`, `stagedWrite.ts` (which re-exports it to the apply-patch tool) |

`diffStat.ts` stays a leaf with no imports but the hunk type:
`collapseReadSearch.ts` runs on every transcript render and must not pull the
write path in.

**`gitStatusDelta.ts`**

| Export | Signature | Used by |
|---|---|---|
| `GIT_STATUS_CONTEXT_KEY` | the literal `'gitStatus'` | `src/providers/transport/api.ts` (drops that key from the system context) |
| `GitStatusDelta` (type) | `{ content: string }` | the return type below |
| `getGitStatusDelta` | `(currentGitStatus: string \| null \| undefined, messages: readonly { type: string; attachment?: { type: string } }[]) => GitStatusDelta \| null` | `src/agent/attachments/injections.ts`, `src/agent/staticDedup.integration.test.ts` |

**`commitAttribution.ts` and `attribution.ts`**

| Export | Signature | Used by |
|---|---|---|
| `AttributionState` (type) | two maps, `fileStates` (path to `FileAttributionState`) and `sessionBaselines` (path to `{ contentHash: string; mtime: number }`); `surface: string`; `startingHeadSha: string \| null`; six counters (see section 11) | `QueryEngine.ts`, `src/tools/Tool.ts`, `src/shared/types/hooks.ts`, `useToolUseContext.ts`, `AppStateStore.ts`, `sessionRestore.ts` |
| `createEmptyAttributionState` | `() => AttributionState` | `src/terminal/state/AppStateStore.ts`, `startupSequence.ts`, `src/commands/clear/conversation.ts` |
| `getClientSurface` | `() => string` | the unit |
| `stateToSnapshotMessage` | `(state: AttributionState, messageId: UUID) => AttributionSnapshotMessage` | the unit |
| `restoreAttributionStateFromSnapshots` | `(snapshots: AttributionSnapshotMessage[]) => AttributionState` | imported, not called, by `src/sessions/sessionRestore.ts` |
| `attributionRestoreStateFromLog` | `(snapshots: AttributionSnapshotMessage[], onUpdateState: (state: AttributionState) => void) => void` | imported, not called, by `sessionRestore.ts` |
| `incrementPromptCount` | `(attribution: AttributionState, saveSnapshot: (snapshot: AttributionSnapshotMessage) => void) => AttributionState` | imported, not called, by `useOnSubmit.ts` and the headless `controlLoop.ts` |
| `sanitizeModelName` | `(shortName: string) => string` | `src/providers/model/fable51.test.ts`, `opus55.test.ts` |
| `AttributionTexts` (type, `attribution.ts`) | `{ commit: string; pr: string }` | the return type below |
| `getAttributionTexts` (`attribution.ts`) | `() => AttributionTexts` | `src/commands/commit.ts`, `src/tools/BashTool/prompt.ts` and its test |

`AttributionSnapshotMessage` and `FileAttributionState` are declared in
`src/shared/types/logs.ts`, outside the unit.

## Observable behaviour

### 1. `fetchGitDiff(root?)`: the per-file numbers

- **The comparison.** The working tree and the index against `HEAD`, so staged and unstaged changes of tracked files both count. Untracked files that git's standard excludes do not ignore (`.gitignore`, `info/exclude`, `core.excludesFile`) are added after them.
- **`stats`.** `filesCount` is the number of tracked files changed, plus the untracked files that got an entry (see "at most 50" below). `linesAdded` and `linesRemoved` are git's line counts over every tracked file. Untracked files add no lines.
- **`perFileStats`.** Tracked files first, in git's order (by path), then untracked files in name order.
  - A tracked file: `{ added, removed, isBinary }`, plus `renamedFrom` when git detected a rename.
  - A binary file: `added` and `removed` are 0 and `isBinary` is `true`.
  - An untracked file: `{ added: 0, removed: 0, isBinary: false, isUntracked: true }`. Untracked files are listed one by one, never as a directory.
  - A key is the path as git prints it relative to the directory git runs in (the root, when one is given).
- **`hunks`.** Always an empty map; `fetchGitDiffHunks` supplies them.
- **At most 50 entries.** The first 50 tracked files, in git's order. Untracked files fill only the entries the tracked ones leave free.
- **More than 500 changed tracked files.** The result is git's totals, an empty `perFileStats` and an empty `hunks`; untracked files are not looked at. At exactly 500 the full detail comes back.
- **A clean repository** gives zeros and two empty maps, not `null`.
- **`null`:**
  - outside a repository;
  - before the first commit (`HEAD` does not resolve), even with staged or untracked files;
  - when git fails;
  - while a merge, rebase, cherry-pick or revert is stopped half-way, that is while the repository's git directory holds `MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD` or `REVERT_HEAD`. For a linked worktree, that is the worktree's own git directory. Once the operation is finished or aborted, the numbers come back.
- **With a root,** git runs in that directory. **Without one,** see finding 6.

### 2. `fetchGitDiffHunks(root?)`: the hunks

- **The same comparison** as section 1 (working tree and index against `HEAD`), parsed as in section 3. Untracked files have no hunks; the reviewer builds theirs with `buildAddedFileHunks` from the file's content.
- **The a/ b/ prefixes are fixed** for this request, so the repository's `diff.noprefix` and `diff.mnemonicPrefix` change nothing. Other diff settings of the repository still apply, for example `diff.context`, `diff.algorithm`, `diff.renames=copies` and `diff.suppressBlankEmpty`.
- **An empty map:**
  - outside a repository, before the first commit, or when git fails;
  - during the stopped operations of section 1;
  - when git's output is larger than 1,000,000 bytes. Then no file gets hunks, not even the small ones (finding 4). Below that bound, a large file's hunks are cut at 400 lines like any other.

### 3. `parseGitDiff(text)`: unified diff to hunks per file

- **File sections.** A new file section starts at every line beginning with `diff --git `. Text with no such line, and empty or blank text, give an empty map.
- **The key** comes from the section's `diff --git` line, by this rule:
  - the line must begin with one character and a slash;
  - the two paths are split at the first space that is followed by one character and a slash;
  - the key is what follows the second prefix, which for a rename or a copy is the new path.

  This rule has several consequences. `a/ b/` works, and so do the mnemonic pairs `c/ w/`, `i/ w/`, `c/ i/` and `o/ w/`. A `diff.noprefix` header matches only when the path's first directory is a single character, and that directory is then left out of the key (`x/one.txt` becomes `one.txt`). A header git had to quote (a non-ASCII name, or a quote, backslash or control character) does not match, and the section is skipped. A path with a space followed by one character and a slash (`dir x/trap.txt`) cuts the header short, and the key becomes the rest (`trap.txt b/dir x/trap.txt`). The Git tool's diff budget derives its own file keys by this same rule and looks the hunks up by them, so the rule must not change.
- **Which files get an entry.** Only a file with at least one hunk. Binary files, mode-only changes, and renames or copies without a content change have none. The entries keep the order of the text.
- **Hunk header** `@@ -a,b +c,d @@ anything`:
  - `oldStart` is a and `oldLines` is b, or 1 when b is omitted;
  - `newStart` is c and `newLines` is d, or 1 when d is omitted;
  - the text after the second `@@` (git's function context) is ignored.
- **Hunk lines.**
  - Every line of the hunk that starts with a space, `+` or `-`, in order and with its first character kept.
  - Empty lines too: a blank context line whose space was stripped, as `diff.suppressBlankEmpty` prints it, stays in place as `""`.
  - `\ No newline at end of file` markers are left out.
  - The lines before a file's first hunk are never hunk lines: `index`, the mode, rename, copy and similarity lines, the `---`/`+++` headers and `Binary files … differ`.
  - Findings 1 and 2 are defects in this list.
- **Limits:**
  - **50 files.** Parsing stops once 50 files have an entry. Sections without hunks do not count toward the 50.
  - **1,000,000 bytes per section.** A section larger than that, counted in UTF-8 bytes from after `diff --git ` through its final newline, is skipped, and the next sections still parse. A section of exactly 1,000,000 bytes is kept.
  - **400 lines per file.** After 400 lines of a file are kept, its later lines are dropped. A hunk that starts after that still appears, with its header numbers and no lines.

### 4. `parseGitNumstat(text)`

- **Input.** One line per file, `<added>\t<removed>\t<path>`. Blank lines around the output are ignored. Lines with fewer than three tab-separated fields are skipped and not counted. A path may itself contain tabs, since everything after the second tab is the path.
- **Renames.** `old => new` gives the key `new` and `renamedFrom: 'old'`, both trimmed. The brace form `pre{old => new}post` gives `pre` + `new` + `post` as the key and `pre` + `old` + `post` as `renamedFrom`, with a doubled slash from an empty side collapsed (`src/{ => core}/lib.ts` is `src/core/lib.ts`, renamed from `src/lib.ts`). A copy, printed the same way when copy detection is on, comes out as a rename.
- **Binary.** A `-` in either count gives `added: 0`, `removed: 0`, `isBinary: true`.
- **`stats`.** `filesCount` is the number of valid lines. `linesAdded` and `linesRemoved` are sums over all of them, not only the kept ones.
- **`perFileStats`.** The first 50 valid lines, in order. `renamedFrom` is present only for a rename (absent, not `undefined`, otherwise), and `isUntracked` is never set. Keys are exactly as printed, so a C-quoted name keeps its quotes and octal escapes.
- **Empty input** gives zeros and an empty map.

### 5. `parseShortstat(text)`

- **Matching.** Finds `N file changed` or `N files changed`, optionally followed by `, N insertion(s)(+)` and `, N deletion(s)(-)`, anywhere in the text, and returns `{ filesCount, linesAdded, linesRemoved }` with the missing parts as 0.
- **No summary line gives `null`,** which is what git's empty output for "no changes" gives.

### 6. `buildAddedFileHunks(content)`: an untracked file as all-added

- **Empty content** gives no hunk.
- **Otherwise one hunk.** `oldStart` and `oldLines` are 0 and `newStart` is 1. Each line is `+` followed by the line, split at `\n`, so a CRLF line keeps its `\r`. One final newline does not add an empty last line, but blank lines inside stay (`a\n\n` gives `+a` and `+`, and `\n` alone gives `+`).
- **At most the first 400 lines,** and `newLines` is the number kept.
- **Not the same as `getPatchFromContents`,** which starts a new file at old line 1.

### 7. `chooseDiffStatScope(head, mergeBase, base)`

`{ kind: 'uncommitted' }` when `mergeBase` is `null` or empty, when `head` is
empty, or when the two are equal. Otherwise
`{ kind: 'branch', against: mergeBase, base }`.

### 8. `fetchDiffStatSummary()`: the footer readout

- **Failures.** Never throws: every git failure reports less.
- **Outside a repository** all three fields are `null`.
- **The base** is `CLAUDIN_BASE_REF` when it is set and not empty. Otherwise it is the repository's default branch as `src/vcs/git/git.ts` reports it: the branch `origin/HEAD` points to, else `main` or `master` when `origin` has one, else `main`.
- **Which comparison.** The scope comes from `HEAD` and its merge-base with the base, as in section 7.
  - **On a branch that has left the base:** `{ uncommitted: null, branch, branchBase: base }`. `branch` measures the merge-base against the working tree, so commits on the branch and uncommitted changes both count, and commits made on the base since the fork do not.
  - **Otherwise** (sitting on the base, no such base, no merge-base): `{ uncommitted, branch: null, branchBase: null }`. `uncommitted` measures the working tree and index against `HEAD`.
- **What counts.** Tracked files only. Untracked files never count.
- **All `null`** when nothing tracked changed (git prints nothing), before the first commit, or when git fails.

### 9. `getPatchFromContents` and `getPatchForDisplay`

- **`getPatchFromContents`.** Returns the hunks between two texts, as the `diff` package's structured patch builds them.
  - Three lines of context. With `singleHunk`, the whole file is context and there is one hunk, for files of up to 100,000 lines.
  - Identical texts give `[]`.
  - A text created from nothing gives one hunk with `oldStart: 1, oldLines: 0`. An emptied text gives `newLines: 0`.
  - A missing final newline is marked by a `\ No newline at end of file` line right after the last line of the side that lacks it.
  - `&` and `$` come through unchanged. Tabs stay tabs.
  - The file path does not affect the hunks.
- **Whitespace** matters by default. With `ignoreWhitespace`, differences at the start or end of a line are ignored, but a difference inside a line still counts. No caller passes `true` today.
- **`getPatchForDisplay`** applies the edits to the file contents in order, each one to the result of the one before, then diffs with three lines of context.
  - **Which occurrence.** An edit replaces the first occurrence of `old_string`, or every occurrence with `replace_all: true`. An edit object with no `replace_all` counts as `false`.
  - **The replacement is literal text,** so `$&`, `$1` and `$$` are not patterns.
  - **No match.** An `old_string` that is not found changes nothing, and no edits at all give `[]`.
  - **An empty `old_string`** on empty contents inserts `new_string`, which is how a new file is shown.
  - **Leading tabs.** Every tab at the start of a line is shown as two spaces, in the file and in both strings of every edit, before the edits are applied. So an edit written with two spaces matches a tab-indented line. An edit whose `old_string` starts with a tab that sits after text on its line in the file matches nothing and shows no hunk (finding 13). A tab after text is kept as a tab.
  - **`ignoreWhitespace`** works as above: an edit that only re-indents shows no hunk.

### 10. `adjustHunkLineNumbers`, `countLinesChanged`, `countAddDel`

- **`adjustHunkLineNumbers(hunks, offset)`.**
  - An offset of 0 returns the same array object.
  - Any other offset, negative included, returns a new array of new hunk objects with `oldStart` and `newStart` moved by the offset. Every other field, the `lines` arrays included, is carried over unchanged, and the input is not modified.
- **`countLinesChanged(patch, newFileContent?)`.** Adds to the session's lines-added and lines-removed totals, the ones `/cost` shows and the project config and cost state store.
  - With at least one hunk, it adds the lines starting with `+` and the lines starting with `-` over all hunks, and ignores the content argument.
  - With no hunks and non-empty content, it adds the content's lines as added, split at `\n` or `\r\n` (finding 9).
  - With no hunks and no content, or empty content, it adds nothing.
- **`countAddDel(hunks)`.** `additions` are the lines starting with `+` and `deletions` the lines starting with `-`, over all hunks. Context lines, markers and empty lines count for neither. A line starting with `+++` or `---` is content here, since hunks carry no file headers.

### 11. `getGitStatusDelta(snapshot, messages)`

- **What it returns.** `{ content: snapshot }`, the snapshot byte for byte (whitespace-only included), when the transcript holds no earlier announcement. `null` in every other case.
- **An announcement** is a message whose `type` is `'attachment'` and whose `attachment.type` is `'git_status_delta'`. Anything else counts for nothing: other attachment types, an attachment message without an `attachment`, or another message type carrying that attachment.
- **Once only.** After the first announcement, nothing is returned again, even when the snapshot has changed. Despite the name, nothing is ever computed between two snapshots.
- **No snapshot** (`null`, `undefined` or empty) gives `null`.
- **The transcript** is only read.
- **The key.** `GIT_STATUS_CONTEXT_KEY` (`'gitStatus'`) is the system-context key this attachment replaces, so the snapshot is not sent twice.

### 12. `getAttributionTexts()`: what is added to a commit or a pull request

- **Any client type except `'remote'`.** `commit` and `pr` come from the merged settings' `attribution.commit` and `attribution.pr`, each `''` when unset, so **nothing is added by default**.
  - Each field comes separately from the highest source that sets it: user, then project, local, flag, and finally managed (policy) settings, the highest.
  - An empty string in a higher source hides the text of a lower one.
  - The text is returned exactly as written: no trimming, no escaping, line breaks and emoji kept.
  - The settings are read through the session's settings cache.
- **Client type `'remote'`.** At startup, that is `CLAUDE_CODE_ENTRYPOINT=remote` or a session-ingress token. The settings are not read at all.
  - **With a remote session id** in `CLAUDE_CODE_REMOTE_SESSION_ID`, both texts are the session link `<site>/code/<id>`. An id starting `cse_` is shown with `session_` in its place. `<site>` is `https://claude-ai.staging.ant.dev` when the id contains `_staging_` or `SESSION_INGRESS_URL` contains `staging`, and `https://claude.ai` otherwise.
  - **A local-development session** (an id containing `_local_`, or an ingress URL containing `localhost`) gets `''` for both.
  - **No id** gets `''` for both.
- **Where the callers put the texts.** Neither caller escapes the text (finding 11).
  - **The Bash tool's git instructions,** which every agent that has Bash reads in its first message:
    - with a commit text, the model is told that every commit message ends with it, as its own paragraph after a blank line, and the example commit command shows it after the body;
    - without one, the model is told to add no AI attribution trailer;
    - with a PR text, the example `gh pr create` body ends with it after a blank line;
    - without one, the model is told to add no AI footer.
  - **The `/commit` prompt:** with a commit text, the example message ends with it after a blank line. Without one, a rule forbids AI attribution trailers.

### 13. Commit-attribution state

- **`sanitizeModelName(id)`.** Returns `claude-<family>` for the first family in this list that the id contains: `fable-5-1`, `fable-5`, `opus-5-5`, `opus-5`, `opus-4-8`, `opus-4-7`, `opus-4-6`, `opus-4-5`, `opus-4-1`, `opus-4`, `sonnet-5`, `sonnet-4-6`, `sonnet-4-5`, `sonnet-4`, `sonnet-3-7`, `haiku-4-5`, `haiku-3-5`. Otherwise it returns `claude`.
  - It matches by containment, so provider prefixes and date suffixes do not matter, and `opus-4-10` is `claude-opus-4-1`.
  - The older family-last form (`claude-3-7-sonnet-…`) is `claude`.
- **`getClientSurface()`.** `CLAUDE_CODE_ENTRYPOINT` as it is (an empty string stays empty), or `'cli'` when it is unset.
- **`createEmptyAttributionState()`.** Every call returns a fresh state:
  - two new empty maps;
  - `surface` from `getClientSurface()` at the time of the call;
  - `startingHeadSha: null`;
  - the six counters at 0 (`promptCount`, `permissionPromptCount` and `escapeCount`, each with an `…AtLastCommit` twin).
- **`stateToSnapshotMessage(state, id)`.** Builds the transcript entry with keys in this order:
  - `type: 'attribution-snapshot'`, `messageId`, `surface`;
  - `fileStates`, as a plain object in the map's order;
  - `promptCount`, `promptCountAtLastCommit`, `permissionPromptCount`, `permissionPromptCountAtLastCommit`, `escapeCount`, `escapeCountAtLastCommit`.

  `sessionBaselines` and `startingHeadSha` are not stored. A transcript holds it as `JSON.stringify` output, one entry per line, and the resume loader recognises the line by its `{"type":"attribution-snapshot"` prefix. So `type` must stay the first key. `__fixtures__/rewrite/attribution-snapshots.jsonl` is the format, byte for byte.
- **`restoreAttributionStateFromSnapshots(list)`.** The last snapshot alone is the state, and nothing is added up across snapshots.
  - From the snapshot: its `surface`, its `fileStates` as a map in the same order, and its counters, with a missing counter as 0.
  - `sessionBaselines` comes back empty and `startingHeadSha` `null`.
  - An empty list gives `createEmptyAttributionState()`.
- **`attributionRestoreStateFromLog(list, callback)`** calls the callback once with that state and returns nothing.
- **`incrementPromptCount(state, save)`.**
  - It returns a new object, a shallow copy with `promptCount` one higher, and does not modify the input.
  - Before returning, it calls `save` once with the snapshot of the new state under a fresh random (version 4) UUID.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| Not a repository, no commit yet, or git fails | `fetchGitDiff` `null`; `fetchGitDiffHunks` empty map; `fetchDiffStatSummary` all `null` |
| Merge, rebase, cherry-pick or revert stopped half-way | `null` and an empty map. The footer readout is not affected. |
| Git output of the hunks request above 1,000,000 bytes | empty map, while `fetchGitDiff` still returns the numbers |
| More than 500 tracked files changed | totals only |
| Mode-only change, empty new file, pure rename, binary file | a numbers entry, no hunks. The reviewer labels the first two "large file" (finding 16). |
| A name git quotes (non-ASCII by default) | quoted key in the numbers, no hunks (finding 3) |
| `diff.noprefix` output given to `parseGitDiff` | sections skipped, or keyed without a one-character first directory |
| The repository's `color.diff=always` or `diff.external` | the hunks request returns an empty map (finding 8) |
| A diff that takes more than 5 seconds to compute (`diff.ts`) | `[]`. Not pinned. |
| A git command slower than its limit (5 seconds, 2 for the footer readout) | treated as a failure. Not pinned. |

## Security requirements

- **Git runs without a shell,** with a fixed argument list; the only variable arguments are the base name and a merge-base hash. The base name comes from `CLAUDIN_BASE_REF`, which the user sets, or from the repository's default branch, and a ref name cannot start with `-`.
- **No index lock.** Every git call passes `--no-optional-locks`, so a background read never takes `index.lock` from under the user's own git commands. The tests cannot observe it; keep it.
- **External diff programs.** The hunks request runs whatever external diff program the repository's configuration names (finding 8). The program is the user's own configuration, since a clone does not carry `.git/config`. The fix turns it off as hardening that legitimate use never notices.
- **The remote session link** in commits and pull requests publishes the session id (finding 12).

## Tests that pin it

- **The suites.** 131 tests, all passing unchanged against the old module.

  | Suite | Tests | What it pins |
  |---|---|---|
  | `src/vcs/git/gitDiff.characterization.test.ts` | 40 | the parsers, against real git output in `__fixtures__/rewrite/` |
  | `src/vcs/git/gitDiff.repo.characterization.test.ts` | 28 | the fetchers, against real repositories built per test with git's global and system configuration shut out |
  | `src/vcs/git/diff.characterization.test.ts` | 28 | `diff.ts` and `diffStat.ts` |
  | `src/vcs/git/gitStatusDelta.characterization.test.ts` | 6 | `gitStatusDelta.ts` |
  | `src/vcs/git/attribution.characterization.test.ts` | 17 | `attribution.ts`: settings from real files, and the placement in the Bash tool's git instructions |
  | `src/vcs/git/commitAttribution.characterization.test.ts` | 12 | `commitAttribution.ts` |

- **How the root-less fetchers are tested.** They run in a fresh `bun` process started inside the repository. They depend on process-wide caches (is the session in a repository, `HEAD`, the default branch) that no test can reset, and calling them in the test process would leave those caches set for every later suite. Coverage cannot see those runs, which is why `gitDiff.ts` reads 87.6% of lines. Every other file is at 98 to 100%.
- **How the defects marked "fix" are kept free.** The suites compare hunks by their own header counts, so they pass with or without the trailing empty line of finding 2, and they avoid the inputs of findings 1, 3, 5, 6 and 7. The rewrite adds tests for those fixes.
- **Fixtures,** captured from git 2.55 in `src/vcs/git/__fixtures__/rewrite/`:
  - `head-vs-worktree.diff`, `.numstat` and `.shortstat`;
  - `copies.diff` and `copies.numstat`;
  - `mnemonic-prefix.diff`, `no-prefix.diff` and `suppress-blank-empty.diff`;
  - `attribution-snapshots.jsonl`.
- **`scripts/migrations/probes/rewrite-vcs-gitDiff.json`.** 40 probes over the six files, every one of which turns the suites red. The runner applies a replacement with `String.replace`, so a `$'` or `$&` in the replacement text is expanded. Write replacements without `$`, as this spec's probes do.
- **Existing tests that stay** (this project's own):
  - `src/vcs/git/gitDiff.test.ts`, `src/vcs/git/gitStatusDelta.test.ts` and `src/vcs/gitDiffStatSummary.test.ts`;
  - `src/agent/staticDedup.integration.test.ts`;
  - `src/tools/BashTool/prompt.test.ts`, which pins the "no AI attribution trailer or footer" rule;
  - the two model tests that use `sanitizeModelName`.
- **Prompt text pinned elsewhere:** none. The unit sends no prose of its own to the model: the status snapshot is built elsewhere, and the attribution texts are the user's or the session link.
- **Not pinned, and why:**
  - **The time limits** (5 seconds per git call and per text diff, 2 seconds for the readout). Hitting them needs a slow git or a pathological diff.
  - **`--no-optional-locks`.** Nothing a caller can see.
  - **The session's settings cache.** Reading attribution through it belongs to the settings module.
  - **The defects marked "fix" below,** on purpose.

## Out of scope

Nothing is dropped. Several exports have no runtime caller and stay for the
transition only, because other modules import them:
- `sanitizeModelName` (called only by two tests);
- `incrementPromptCount`, `restoreAttributionStateFromSnapshots` and `attributionRestoreStateFromLog` (imported but never called);
- `parseShortstat` and `getClientSurface` (no importer outside the unit).

See finding 14.

## Findings

1. **Content lines that look like file headers are dropped.** In `parseGitDiff`, a removed line whose text starts with `--` (the diff line starts `---`) or an added line whose text starts with `++` (`+++`) disappears from its hunk. That covers Markdown rules and front matter (`---`), SQL, Lua and Haskell comments (`--`), and `++i`. The hunk then disagrees with its header, and the reviewer shows the change without those lines.
   - **Decision: fix.** Within a file section, `---` and `+++` lines are headers only before the first hunk. After it, every line starting with a space, `+` or `-` is content.
   - The Git tool's own per-file counts skip the same lines (outside this unit, tracked).
2. **A phantom empty line.** The last hunk of every file ends with one extra `""`, made by the newline that ends the file's section. The reviewer draws it as a blank context row, and the Git tool's diff text gets a blank line.
   - **Decision: fix.** Drop that one element and keep empty lines inside hunks.
3. **Quoted names.** For names git quotes (non-ASCII by default; also quotes, backslashes and control characters):
   - `fetchGitDiff` keys them in quoted, octal-escaped form (`"caf\303\251.txt"`);
   - `fetchGitDiffHunks` has no hunks for them;
   - an untracked one is listed under a name that does not exist on disk, so the reviewer cannot read it.

   **Decision: fix in the fetchers.** Ask git for unquoted non-ASCII names (`core.quotePath=false`) in the numbers, the hunks and the untracked list. The parsers keep names exactly as given, because the Git tool parses raw user output by the same rule.
4. **One large file hides all hunks.** `fetchGitDiffHunks` returns nothing when git's output passes 1,000,000 bytes, so one large file hides every file's hunks and the per-file cap of section 3 never applies.
   - **Decision: keep for parity.** The bound is what keeps a huge diff out of memory. Keeping the files that fit within it is an improvement to track. Pinned.
5. **Untracked files are undercounted.** `filesCount` counts every tracked change, but only the untracked files that got one of the 50 entries, and none when tracked changes fill them.
   - **Decision: fix.** Count every untracked file git lists. Not pinned in the capped case.
6. **Without a root, the fetchers mix directories.**
   - Whether the session is in a repository is decided once per process.
   - The stopped-operation check looks at the session's current directory.
   - git itself runs in the process's directory, which the shell's `cd` does not move.

   Nothing calls them without a root today (`useDiffData` has no caller). **Decision: fix.** Without a root, every step uses the repository around the session's current directory, decided at each call.
7. **Untracked names depend on where git runs.** The untracked list covers only the directory git runs in, with names relative to it, while tracked names are relative to the root. Given a subdirectory, the two sets of names do not match and the rest of the repository's untracked files are missing.
   - **Decision: fix.** Untracked names are relative to the repository root and cover the whole repository.
8. **The user's configuration can break the hunks.** A repository's `color.diff=always` (or `color.ui=always`) or `diff.external` turns the hunks request's output into something the parser cannot read, so the result is an empty map. With `diff.external`, the configured program also runs on every request.
   - **Decision: fix.** The hunks request turns color and external diff programs off, as it already fixes the prefixes.
9. **A new file counts one line too many.** `countLinesChanged` counts a new file's final newline as a line: `a\nb\n` adds 3.
   - **Decision: fix.** A final newline ends the last line (2), as in `buildAddedFileHunks`.
   - The totals are stored, in the project config and the cost state, but only as running sums; nothing depends on the extra line.
10. **Marker sequences are altered.** `diff.ts` returns a text containing certain long marker sequences (not something a real file holds) with those sequences turned into `&` or `$`.
    - **Decision: fix.** Hunk lines carry the texts exactly, whatever they contain.
11. **The callers do not escape the attribution text.** The Bash tool's instructions and `/commit` put the text into their example commands as it is, so a text with a quote or a backslash makes the example command malformed.
    - **Decision: outside this unit, tracked.** The unit's contract stays "verbatim".
12. **Remote sessions ignore attribution settings.** They put the session link, which publishes the session id, in every commit and pull request, although Claudin otherwise adds nothing by default.
    - **Decision: keep for parity.** The remote runtime starts and configures those sessions, and the link is how their commits lead back to them. Revisit with the bridge and remote rewrite (phase 8).
13. **A mid-line tab hides an edit in the display.** An edit whose `old_string` starts with a tab that sits after text on its line shows no hunk in `getPatchForDisplay`, although the edit tool applies it, so a permission dialog can show an empty diff for a real change. Applying the edits before converting tabs would instead hide the edits that match only through the conversion, which the edit tool's indentation-tolerant matching also accepts.
    - **Decision: keep for parity.** The real fix renders the edit tool's own result. Track it with the tools rewrite.
14. **The attribution pipeline is dead.**
    - Nothing ever writes or restores an attribution snapshot.
    - `fileStates` and `sessionBaselines` are always empty at runtime.
    - `sanitizeModelName` no longer feeds any commit trailer.
    - The old module's own comment claims the pipeline is live, and it is wrong.

    **Decision: keep the exports and their pinned behaviour** while their importers exist. Do not carry the comment over. Drop them when the importers are rewritten.
15. **The schema description is wrong.** The settings schema describes `attribution` as defaulting to "the standard Claudin attribution" when unset, but nothing is added when it is unset.
    - **Decision: fix the description** in `src/platform/settings/types.ts` (outside the unit, tracked).
16. **Changes without content show as "large file".** Mode-only changes and empty new files have a numbers entry but no hunks, and the reviewer labels them "large file".
    - **Decision: keep for parity.** The Git tool relies on a missing entry to print its stat line. The label is the reviewer's to fix (tracked).
17. **Copies read as renames.** With `diff.renames=copies`, a copy carries `renamedFrom` and shows as a rename.
    - **Decision: keep for parity.** The numstat notation does not tell the two apart. Pinned.
18. **Outside this unit: the stash diff is empty.** git 2.55 prints `diff --git Uh.ts h.ts` for `git stash show -p --src-prefix=a/ --dst-prefix=b/`. The prefixes come out garbled, so the reviewer's stash diff (`gitLog.ts`) parses to nothing.
    - **Decision: tracked** for the reviewer's rewrite. Plain `stash show -p`, or `git diff <stash>^ <stash>`, prints proper prefixes.

## Target design

- **Pure parsing** of git's text output, with no process spawning:
  - unified diff to hunks per file, the limits included;
  - numstat, with rename-path resolution;
  - shortstat;
  - the readout scope.
- **One repository reader** for the three fetchers:
  - a single place builds the git invocation, with the root as working directory and the fixed flags (no optional locks, a/ b/ prefixes, no color, no external diff, unquoted names) and time limit;
  - a separate check for the stopped operations;
  - it fails open everywhere.
- **Text patches:**
  - a thin adapter over the `diff` package;
  - a display step (edits applied, leading tabs shown as spaces) layered on top;
  - the session-total update separated from counting, which reuses `countAddDel`.
- **`diffStat.ts` and `gitStatusDelta.ts` stay pure leaves.**
- **Attribution:** one function resolves the texts (remote session or settings). The commit-attribution state is pure functions plus a snapshot codec whose key order is part of the format.
- **Types:** explicit throughout and no `any`. Keep every export of the contract table while its importers exist.

## Outcome

**Residue, reviewed.**
- **`src/vcs/git/gitDiff/types.ts`, 7 lines of Claude Code.** The declarations of `GitDiffStats`, `PerFileStats`, `NumstatResult` and `GitDiffResult`, and the `perFileStats` and `hunks` fields of the last two. The contract table fixes those names, fields and types, and `useDiffData.ts`, `useWorkspaceDiff.ts` and `gitLog.ts` read them. They go when the contract is redesigned, after every consumer has been rewritten.
- **`src/vcs/git/commitAttribution.ts`, 13 lines.** The counters of `AttributionState`, which are written into the transcript's attribution snapshots and read back on resume; the `sessionBaselines` and `surface` fields of a fresh state; and the signatures of `createEmptyAttributionState`, `attributionRestoreStateFromLog` and `incrementPromptCount`, which the REPL and the resume path call.
- **`src/vcs/git/diff.ts`, 6 lines.** The exported `CONTEXT_LINES` and `DIFF_TIMEOUT_MS`, whose values the suite pins, and the signatures of `getPatchFromContents` and `getPatchForDisplay`, with the `ignoreWhitespace = false` default their callers rely on.
- **`src/vcs/git/attribution.ts`, 2 lines.** The reads of `CLAUDE_CODE_REMOTE_SESSION_ID` and `SESSION_INGRESS_URL`. The remote session's environment sets those names, so they are protocol.

The last three files were rewritten at their old paths. The baseline still allowed them their old counts, so the gate did not flag them, and they were reviewed by hand.
