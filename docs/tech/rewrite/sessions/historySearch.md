# Spec: `sessions/historySearch`

The unit is three files:
- `src/sessions/hooks/useHistorySearch.ts`, the inline prompt-history search;
- `src/sessions/ui/HistorySearchDialog.tsx`, the Ctrl+R history picker;
- `src/sessions/transcriptSearch.ts`, the text the transcript's `/` search looks in.

## Purpose

**Getting back to an earlier prompt.** The user can pull a prompt they typed
before back into the prompt box, in one of two ways. Both read the prompt
history that the history module (`src/agent/history.ts`) keeps under the
config directory.
- **The inline search** (`useHistorySearch`). While the user types a query in
  the footer, the prompt box shows the newest earlier prompt that contains it,
  and Ctrl+R steps back through older ones.
- **The picker** (`HistorySearchDialog`). A list of this project's recent
  prompts, filtered as the user types, with a preview of the focused one.

**Which one Ctrl+R opens** depends on the build flag `HISTORY_PICKER`
(`scripts/build/build.ts`):
- **Flag on, as the shipped build has it:** Ctrl+R opens the picker, and the
  inline search cannot be started at all (Findings).
- **Flag off, as under `bun test`:** Ctrl+R starts the inline search.

**The transcript search.** `renderableSearchText` turns one transcript
message into the lower-case text that the transcript's search looks for the
query in. It covers only what the screen shows for that message.

The caller of the first two is `src/terminal/prompt-input/PromptInput.tsx`.
- **For the hook,** it owns the prompt's state and hands the hook the current
  values and their setters. It shows the query in the footer: `search
  prompts:`, or `no matching prompt:` while the search has failed. It shows
  the match in the prompt box, without its leading `!`. While a search runs
  with a match that has not failed, it highlights the query's length of
  characters starting at the cursor offset that the hook set. On Enter, it
  sets the submitted pastes and submits the text.
- **For the dialog,** it mounts it on Ctrl+R with the prompt's current text as
  `initialQuery`, and hides it on select or cancel. It keeps it mounted while
  hidden and drops it after five minutes hidden.
- **On select,** it takes the mode from a leading `!`, puts the text without
  the `!` in the prompt, applies the pastes and moves the cursor to the end.

The REPL (`src/agent/repl/REPL.tsx`) owns `isSearchingHistory`. It also keeps
the cancel-request handler off while a search runs.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `useHistorySearch` | `(onAcceptHistory: (entry: HistoryEntry) => void, currentInput: string, onInputChange: (input: string) => void, onCursorChange: (cursorOffset: number) => void, currentCursorOffset: number, onModeChange: (mode: PromptInputMode) => void, currentMode: PromptInputMode, isSearching: boolean, setIsSearching: (isSearching: boolean) => void, setPastedContents: (pastedContents: HistoryEntry['pastedContents']) => void, currentPastedContents: HistoryEntry['pastedContents']) => { historyQuery: string; setHistoryQuery: (query: string) => void; historyMatch: HistoryEntry \| undefined; historyFailedMatch: boolean; handleKeyDown: (e: KeyboardEvent) => void }` | `src/terminal/prompt-input/PromptInput.tsx` (reads the first four fields) |
| `HistorySearchDialog` | a React function component taking `{ initialQuery?: string; onSelect: (entry: HistoryEntry) => void; onCancel: () => void }` | `src/terminal/prompt-input/PromptInput.tsx` |
| `renderableSearchText` | `(msg: RenderableMessage) => string` | `src/agent/ui/Messages.tsx`, `src/terminal/VirtualMessageList.tsx` |
| `toolUseSearchText` | `(input: unknown) => string` | the module itself, and the suite (`knip-baseline.json` lists it as unused) |
| `toolResultSearchText` | `(r: unknown) => string` | the same |

Where the types come from:
- `HistoryEntry` (`{ display: string; pastedContents: Record<number, PastedContent> }`) is in `src/platform/config/config.ts`.
- `PromptInputMode` is in `src/shared/types/textInputTypes.ts`.
- `KeyboardEvent` is in `src/terminal/ink/events/keyboard-event.ts`.
- `RenderableMessage` is in `src/shared/types/message.ts`.

The hook's positional signature is contract while `PromptInput.tsx` is not
rewritten.

**Collaborators.** These exports of other modules define what the unit reads
and shows. The rewrite uses them rather than reimplementing them:

| What | Defined by |
|---|---|
| the history, every project, newest first, pastes resolved | `makeHistoryReader()` in `src/agent/history.ts` |
| this project's history for the picker: newest first, one entry per distinct text, at most 100, pastes resolved on demand | `getTimestampedHistory()` in `src/agent/history.ts` |
| the mode of a stored prompt, and its text without the mode character | `getModeFromInput`, `getValueFromInput` in `src/terminal/prompt-input/inputModes.ts` |
| an age | `formatRelativeTimeAgo` in `src/shared/text/format.ts` |
| cutting a row to width | `truncateToWidth` in `src/shared/text/format.ts` |
| wrapping the preview | `wrapAnsi` in `src/terminal/ink/wrapAnsi.ts` |
| key bindings | `useKeybinding` and `useKeybindings` in `src/terminal/keybindings/useKeybinding.ts`, over the default bindings of `src/terminal/keybindings/defaultBindings.ts` |
| the modal-overlay registry | `useRegisterOverlay` in `src/terminal/contexts/overlayContext.tsx` |

## Observable behaviour

### 1. Where the prompts come from

- **The file.** It is `history.jsonl` in the config directory:
  `CLAUDIN_CONFIG_DIR`, or `~/.claudin`, looked up when it is read. It holds
  one JSON object per line, appended as prompts are submitted.
- **The fields the unit depends on:**
  - `display`: the prompt's text. A bash-mode prompt starts with `!`.
  - `timestamp`: in milliseconds.
  - `project`: the session's project root.
  - `pastedContents`: pastes by id.
  - `sessionId`: also present.
- **How pastes are stored:**
  - **A small text paste** is stored inline: `{ id, type: "text", content }`.
  - **A text paste over 1024 characters** is stored as `{ id, type: "text",
    contentHash }`, and its text lives in `paste-cache/<contentHash>.txt` next
    to the history file.
  - **Images** are never written to the history.

  `src/sessions/__fixtures__/rewrite/historySearch/` holds a history file and
  a paste store written by the real writer.
- **Newest first.** "Newest" means the order in which lines were written: the
  last line first, whatever the timestamps say. Prompts of the current session
  that are not written yet come before the file (the history module's
  behaviour, not pinned here).
- **Pastes come back resolved.** An inline one is used as it is. A hashed one
  is read from the paste store. One whose stored file is missing is left out
  of the entry. The resolved form is `{ id, type, content }`, plus `mediaType`
  and `filename` when stored.
- **Skipped lines:** blank lines, lines that are not JSON, and JSON `null`.
- **The inline search** reads every project's prompts, and there is no limit
  on how far back it goes.
- **The picker** reads only entries whose `project` is a string equal to the
  session's project root (`getProjectRoot()`). It keeps the newest occurrence
  of each distinct text and stops after 100 distinct texts. Lines of other
  projects and repeats do not count toward the 100.

### 2. The inline search: `useHistorySearch`

The hook never renders anything. It acts through the callbacks it is given
and the values it returns. "The prompt" below means the caller's input,
cursor offset, mode and pastes.

**Starting.**
- **Ctrl+R starts a search** when no search runs. That is the `history:search`
  action in the `Global` context, and it is only active when the build flag
  `HISTORY_PICKER` is off.
- **What starting does:**
  - it calls `setIsSearching(true)`;
  - it remembers the prompt as it is at that moment (input, cursor, mode,
    pastes);
  - it changes nothing else. The query is empty, there is no match and no
    failure.

**The query.** The caller passes the query in through `setHistoryQuery`.
Every change of the query starts a new scan from the newest prompt. The scan
forgets which prompts it has already shown.
- **A non-empty query** matches the first prompt in the order of section 1
  whose full text contains the query. It is a case-sensitive substring test
  over every line of the prompt. When one matches:
  - `historyMatch` becomes `{ display, pastedContents }` of that prompt, and
    `historyFailedMatch` becomes `false`;
  - the mode becomes the prompt's mode (`bash` when it starts with `!`,
    `prompt` otherwise). This happens even when the search started in another
    mode;
  - the input becomes the prompt's stored text, with its `!`;
  - the pastes become the prompt's resolved pastes;
  - the cursor goes to the last occurrence of the query in the prompt's text
    without the `!`. When the query only occurs through the `!` (for example
    `!git` in `!git status`), the cursor is its offset in the stored text
    instead: 0 for that example.
- **When nothing matches:** `historyFailedMatch` becomes `true`, and the
  previous match stays. That covers `historyMatch`, the input and the rest of
  the prompt. With no previous match, the prompt stays as it was.
- **An empty query** puts the prompt back as it was when the search started:
  input, cursor, mode and pastes. It clears the match and the failure, and
  the search goes on.

**Ctrl+R while searching** (`historySearch:next`). It continues the same scan
from where it stopped, to the next older prompt that contains the query.
- **Once per text.** A text shown once in this scan is skipped. A text with
  and without a leading `!` counts as two texts.
- **When no older match is left,** `historyFailedMatch` becomes `true` and the
  last match stays. Further presses keep reporting the failure.
- **With an empty query,** Ctrl+R behaves like emptying the query.

**Ending a search.** All of the following end the search:
- they call `setIsSearching(false)`;
- they clear the query, the match and the failure;
- they forget the remembered prompt;
- the next Ctrl+R starts a fresh search from the prompt as it is then.

| Key (action) | Effect on the prompt | Submits |
|---|---|---|
| Esc or Tab (`historySearch:accept`) | **With a match:** the input becomes the match's text without its `!`, the mode and the pastes the match's. The cursor stays where the search put it. **Without one:** the input stays, and the pastes are the remembered ones. | nothing |
| Ctrl+C (`historySearch:cancel`) | Input, cursor and pastes go back to the remembered ones. See Findings for the mode. | nothing |
| Backspace on an empty query | the same as Ctrl+C | nothing |
| Enter (`historySearch:execute`) | **Empty query:** nothing changes, the mode included. **With a match:** the mode becomes the match's. **A query that matched nothing:** nothing changes. | **Empty query:** `onAcceptHistory({ display: remembered input, pastedContents: remembered pastes })`. **With a match:** `onAcceptHistory({ display: the match's text without "!", pastedContents: the match's })`. **A query that matched nothing:** nothing. |

- **Backspace on a non-empty query** is the query box's edit and does not end
  the search.
- **While no search runs,** Esc, Tab, Enter, Ctrl+C and Backspace do nothing
  to the search.

**`handleKeyDown`.** It takes a keyboard event.
- **When it acts:** a search runs, the query is empty, and the key is
  Backspace. It then marks the event handled (`preventDefault`) and ends the
  search as Ctrl+C does.
- **Otherwise** it does nothing and leaves the event alone.

The hook also listens for that Backspace itself, so no caller has to wire
`handleKeyDown`, and none does.

### 3. The picker: `HistorySearchDialog`

**Loading.**
- **When the history is read:** once per mount, when it mounts. Prompts
  written while it is open do not appear until it is mounted again.
- **Until the read finishes,** the list area says `Loading…`. The first
  painted frame always shows it.

**The screen**, top to bottom:
- the title `Search prompts`;
- the list, and the preview (see Layout);
- the query box, a bordered line with `⌕` and the query, or the placeholder
  `Filter history…` when the query is empty;
- the hint line: `↑/↓ to navigate · Enter to use · Esc to cancel` from 120
  columns up, and `↑/↓ to nav · Enter to use · Esc to cancel` below that.

**The list.**
- **Order:** newest at the bottom, next to the query box, and older ones going
  up.
- **Rows:** at most 8 at a time, fewer on a short terminal (terminal rows
  minus 10, but at least 2).
- **Scrolling:** the window scrolls to keep the focused row in view.
  - The mark column shows `↑` on the top row when older rows are hidden above.
  - It shows `↓` on the bottom row when newer rows are hidden below.
  - The focused row's `❯` wins over either.
- **The focus** starts on the newest row, and goes back there whenever the
  query changes.

**A row** reads: the mark column (`❯ ` on the focused row), then the age, then
one space, then the first line of the prompt.
- **The age** is `formatRelativeTimeAgo(timestamp)`, for example `5m ago`,
  `2h ago`, `3d ago`, `2w ago`, `1mo ago`, `11mo ago` or `1y ago`. It is
  padded with spaces to 8 columns.
- **The first line** is cut with `truncateToWidth` to the row width:
  - from 100 columns, the list width is ⌊(columns − 6) / 2⌋;
  - below 100, the list width is columns − 6;
  - the row width is max(20, list width − 9).

  At 120 columns that is 48 (47 characters and `…`). At 100 it is 38, and at
  99 it is 84.

**The preview** shows the focused prompt in a rounded, dim border.
- **Wrapping:** the whole text, wrapped hard (long words are broken) to the
  preview width:
  - from 100 columns: max(20, columns − list width − 12), which is 51 at 120
    columns;
  - below 100: max(20, columns − 10), which is 70 at 80 columns.
- **Blank lines** (empty or whitespace only) are dropped after wrapping.
- **Length:** at most 6 lines. With more, the first 5 are shown, then
  `… +N more lines`, N being the lines not shown.
- **Layout:** from 100 columns the preview sits to the right of the list.
  Below that, it goes under the list, above the query box.

**Filtering.**
- **The query is trimmed and lower-cased.** An empty result lists everything.
- **Otherwise** the list keeps:
  - first, the prompts whose lower-cased full text contains the query;
  - then, the prompts whose lower-cased full text holds the query's
    characters in order, gaps allowed. Spaces count as characters.

  Each group keeps the newest-first order. Any line of a prompt can match,
  though a row shows only the first.

**Notices**, in place of the list when it is empty:
- `Loading…` before the history is read;
- `No matching prompts` when the query box is not empty (see Edge cases for a
  query of spaces);
- `No history yet` otherwise.

**Keys.**
- **Typing, pasting and Backspace** edit the query. The query box's usual
  editing keys work too: arrows left and right, Home and End, Ctrl+A, Ctrl+E,
  Ctrl+W, Ctrl+U and the others.
- **Backspace on an empty query does nothing.** It does not close the picker.
- **↑ and Ctrl+P** move the focus to the next older row. **↓ and Ctrl+N** move
  it to the next newer one. Both stop at the ends.
- **Enter, Tab and Shift+Tab** pick the focused prompt:
  - they resolve its pastes (section 1) and then call `onSelect({ display,
    pastedContents })` with the text as stored, `!` included. The call comes
    after the pastes are read, not during the key press;
  - with nothing listed, they do nothing.
- **Esc, Ctrl+C and Ctrl+G** call `onCancel()` once per press. **Ctrl+D**
  does the same when the query is empty. With text in the query, Ctrl+D
  deletes the character under the cursor.
- **The picker never closes itself.** After a pick or a cancel it stays up
  and keeps working until the caller takes it away.

**The overlay.** While it is mounted, the picker is registered as an active
modal overlay in the app state, under the id `history-search`, so
`useIsModalOverlayActive()` is `true`. Other key handlers stand down while it
is up. The overlay is removed when it unmounts.

### 4. The transcript search

**`renderableSearchText(msg)`** returns the searchable text of one message,
lower-cased. What each kind of message contributes:

| Message | Contributes |
|---|---|
| user, text content | the text; nothing when the text is exactly one of the two interruption notices (`INTERRUPT_MESSAGE`, `INTERRUPT_MESSAGE_FOR_TOOL_USE` in `src/agent/messages/constants.ts`), which render as a badge |
| user, block content | in order, one per line: each text block that is not exactly an interruption notice, and for each tool-result block the searchable text of the message's `toolUseResult` (below). The tool-result block's own content (the model-facing text) never counts. Other blocks (images) contribute nothing |
| assistant | in order, one per line: each text block, and for each tool-use block the searchable text of its input (below), an empty line when there is none. Thinking, redacted thinking and other blocks contribute nothing |
| attachment of type `queued_command` whose `commandMode` is not `task-notification` and which is not `isMeta` | its prompt: the text, or its text blocks one per line |
| any other attachment, system message, progress message, grouped tool use, collapsed read or search group | nothing |

**The steps, in order:**
1. **Reminders are cut.** Every `<system-reminder>…</system-reminder>` span
   is removed, wherever it sits, across lines and across blocks. The tags are
   matched exactly, in lower case. An opening tag with no closing tag after
   it is left in, with everything after it.
2. **The result is lower-cased.**
3. **It is computed once per message object** and reused. A later change to
   that same object is not seen, so callers treat messages as immutable. It
   has to stay cached: the search runs on every keystroke over the whole
   transcript.

**`toolUseSearchText(input)`** returns the visible arguments of a tool call,
keeping their case.
- **The string fields,** in this fixed order whatever the input's order:
  `command`, `pattern`, `file_path`, `path`, `prompt`, `description`,
  `query`, `url`, `skill`. Each is one line.
- **Then the lists** `args` and `files`, when every element is a string, each
  joined with spaces as one line.
- **Anything else is ignored:** other fields, values of the wrong type, and
  lists holding a non-string.
- **Not an object** (or null): the result is `''`.

**`toolResultSearchText(r)`** returns the text of a tool's own output,
keeping its case.
- **A string** is its own text.
- **Anything else that is not an object** gives `''`.
- **An object with a string `stdout`** gives the stdout, then a newline and
  the `stderr` when that is a non-empty string. Nothing else in the object
  counts. An empty stdout with a stderr gives a newline and the stderr.
- **An object whose `file.content` is a string** gives that content.
- **Otherwise,** one per line:
  - the string fields `content`, `output`, `result`, `text` and `message`, in
    that order;
  - then the lists `filenames`, `lines` and `results`, when every element is
    a string, each joined with newlines.

  Other fields are ignored: `rawOutputPath`, `backgroundTaskId`, `filePath`,
  `durationMs` and the rest.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| No history file | Inline: every query fails. Picker: `No history yet`. | yes |
| History only from other projects | Picker: `No history yet`. Inline: those prompts match. | yes |
| A line that is not JSON, a blank line, `null` | skipped by both | yes (picker: all; inline: bad JSON and blank) |
| A JSON value without a string `project` (a number, an object without it) | skipped by the picker | yes |
| A line with a `project` but no string `display` | **Inline:** the scan throws when it reaches the line (an unhandled rejection), and older prompts are never reached. **Picker:** loading throws and the picker says `Loading…` forever. | no: a defect, see Findings |
| Two prompts with the same timestamp | Both listed. The old picker gives the two rows the same React key, and React warns on stderr. | both listed: yes |
| Timestamps out of order in the file | the file's order wins; each row shows its own age | yes |
| A timestamp in the future | the age reads `in 5m` and so on | no |
| A paste whose stored file is missing | left out of the entry; the others stay | yes |
| A query of spaces only, with nothing listed | The notice says `No matching prompts`, although the filter treats the query as empty. With history, everything is listed. | listing: yes; notice: no |
| Fast typing in the inline search | The prompt can land on an older match, or report a failure while showing a match. | no: a defect, see Findings |
| A very long history | Inline: searched to the first line. Picker: the newest 100 distinct prompts of the project. | yes |
| Terminal narrower than a row's fixed parts | the row width never goes below 20 | no |
| A reminder tag in upper case | not cut; lower-cased like the rest | no |
| A tool list that is empty | adds an empty line to the tool's text | no |
| A user message with two tool-result blocks | the message's tool output appears once per block | no |

## Security requirements

- **Read-only.** Neither the hook nor the picker writes the history file or
  the paste store.
- **Scope of the inline search.** It surfaces prompts typed in any project:
  the history file is shared. The picker limits itself to the session's
  project. This is kept as it is and pinned. The inline search cannot be
  reached in the shipped build (Findings).
- **Only what the screen shows is indexed.** The transcript search leaves
  out:
  - the model-facing text of tool results, such as background-task ids,
    persisted-output wrappers and safety reminders;
  - system reminders;
  - thinking;
  - interruption notices;
  - task notifications and system-injected prompts.

  A match must never point at text the user cannot see. This is pinned.
- **Outside this unit: a paste's hash names a file.** The history module and
  `src/terminal/input/pasteStore.ts` read `paste-cache/<contentHash>.txt`
  with the hash taken from the history line and not validated. A history line
  whose hash holds `../` would read a `.txt` file outside the paste store into
  a recalled prompt. Only someone who can already write the user's history
  file can do that. Record it for the paste store's own rewrite, where
  accepting only 16 hexadecimal characters is pure hardening.

## Tests that pin it

- **`src/sessions/historySearch.characterization.test.tsx`.** 61 tests: 31 on
  the hook, 30 on the picker. Together with the suite below, they cover 100%
  of the functions of all three files, and 99.16% of the lines of
  `useHistorySearch.ts` and 97.92% of `HistorySearchDialog.tsx`. The
  uncovered lines are a guard that no key reaches, and the path where the
  picker is unmounted mid-load. Both suites together run in about 7 s, and
  they passed three runs in a row.
- **`src/sessions/transcriptSearch.characterization.test.ts`.** 28 tests.
  They cover 100% of `transcriptSearch.ts`. Messages are built with the agent
  loop's own factories (`createUserMessage`, `createAssistantMessage`,
  `createAttachmentMessage` and the rest).
- **The fixture, `src/sessions/__fixtures__/rewrite/historySearch/`.** A
  `history.jsonl` and a `paste-cache/202210f25fae3b65.txt`, written on
  2026-09-28 by the real `addToHistory` into a temp config directory. The
  project roots are `/work/fixture` and `/work/elsewhere`. It holds eight
  prompts:
  - one plain prompt, typed twice;
  - a bash-mode prompt;
  - one prompt with a small paste;
  - one with a 40-line paste, moved to the store;
  - one with an image, dropped;
  - one from the other project;
  - one on two lines.

  Both the picker and the inline search are run over it.
- **How the suite drives the unit.** The rewrite has to keep working under
  this:
  - **The mount.** A real Ink root with the fake terminal
    (`src/terminal/__testutils__/fakeTerminal.ts`): 120 columns by default,
    24 rows, and `exitOnCtrlC: false`. The tree is `KeybindingSetup` inside an
    `AppStoreContext` provider whose store holds only `activeOverlays`. The
    suite reads the overlay through `useIsModalOverlayActive()`. So the picker
    must need nothing else from the app state.
  - **Keys** go in as raw bytes: `\x12` Ctrl+R, `\x1b` Esc, `\t` Tab,
    `\x1b[Z` Shift+Tab, `\r` Enter, `\x03` Ctrl+C, `\x07` Ctrl+G, `\x04`
    Ctrl+D, `\x10` Ctrl+P, `\x0e` Ctrl+N, `\x7f` Backspace and the arrow
    sequences. The suite waits for effects before the first key, because a
    key that arrives before the handlers subscribe is lost.
  - **The hook** runs inside a small prompt component. It holds input, cursor,
    mode, pastes and `isSearching` as React state, and passes the setters
    straight in. It stands in for the footer's query box:
    - pasted or typed text is appended to the query;
    - Backspace removes one character;
    - Ctrl+U clears the query.

    Queries of more than one character arrive as one bracketed paste, so each
    one starts exactly one scan (see Findings on fast typing).
  - **The picker** is read off the last painted frame:
    - a row is a line of two spaces, the mark column, the age padded to 8, a
      space and the text;
    - the preview is the text inside the `│` borders above the query box;
    - the query box is the line with `⌕`;
    - the notices are whole lines;
    - the hint is the last line.

    The suite also waits for a focused row after loading. For one frame after
    the list arrives no row has the focus yet. That is the design-system
    picker's behaviour.
- **`scripts/migrations/probes/rewrite-sessions-historySearch.json`.** 40
  probes: 16 on the hook, 13 on the picker, 11 on the transcript search. Every
  one turns the suites red.
- **No other test** exercises these exports.
- **Not pinned, and why:**
  - **The `HISTORY_PICKER` switch.** `feature()` is always false under
    `bun test`.
  - **Styling:** dim text, colours, the focused row's colour.
  - **The rows marked "no"** in Edge cases, and the defects in Findings,
    whose old behaviour must not be carried over.
  - **The mode after Ctrl+C** or Backspace-cancel, after a match that changed
    it (Findings).
  - **Queries typed as separate keys faster than a search completes.** The
    old result depends on timing (Findings). The suite types single
    characters only after the previous search has landed.
  - **Ctrl+R while searching with an empty query,** and **the
    `!`-and-no-`!` texts counting as two** in a scan.
  - **The picker's query-box editing keys** beyond typing, pasting and
    Backspace, and the row count on a short terminal. They belong to the
    design-system picker the dialog is built on.
  - **Unmounting the picker while it loads.** No error, and no callback, is
    observable in either case.
- **Prompt text.** The unit sends nothing to a model, so no file outside the
  unit pins prompt text for it.

## Out of scope

Nothing the unit does is dropped. Choosing between the inline search and the
picker is the caller's and the build's job, and stays there.

## Findings

| Finding | Decision |
|---|---|
| **Fast typing, inline search.** Keys that arrive faster than the history is read reach the query as separate changes: a fast typist, key repeat, or text sent as keystrokes. The search for an earlier, shorter query can then still act on the prompt, and the result depends on timing. Examples seen while characterizing: <br>– With history `npm run build`, `other`, `npm run build -- --watch`, typing `build` as five quick keys lands on `npm run build`, not on the newest match. <br>– With a single matching prompt, the prompt shows the match while `historyFailedMatch` is `true`, so the footer says `no matching prompt`. <br>A pasted query (one change) is not affected. | **Fix.** Once the query has changed, a search for an earlier query has no effect at all. Pin it in the new module's own tests: type a query as separate keys, and the newest match of the full query wins. |
| **Ctrl+C and Backspace-cancel keep the match's mode.** After a match switched the prompt to bash mode, cancelling gives back the input, cursor and pastes but leaves bash mode on. Emptying the query, by contrast, does restore the mode. | **Fix.** Cancel restores the remembered mode too. Nothing can depend on the old behaviour: it is unreachable in the shipped build, and the result is a prompt in the wrong mode. |
| **An entry without a string `display` breaks both.** The inline scan throws an unhandled rejection at that line, and older prompts become unreachable. The picker never leaves `Loading…`. | **Fix.** Skip such entries, as bad JSON is skipped. This is pure hardening. |
| **The inline search is unreachable in the shipped build.** With `HISTORY_PICKER` on, its Ctrl+R binding is never active, and nothing else sets `isSearchingHistory`. | **Keep for parity.** `PromptInput.tsx` still calls the hook and reads its values, and a build with the flag off uses it. Removing the inline mode is a product decision, taken after `PromptInput.tsx` is rewritten. |
| **Duplicate React keys** for two prompts with the same timestamp. The row key is the timestamp. | **Fix.** Keys are unique per listed prompt. The suite pins that both rows are listed. |
| **A query that reaches into the `!`** puts the cursor at its offset in the stored text, not in the text shown. The prompt input then highlights one character too far. | **Keep for parity,** since it is pinned. Changing it means changing the highlight in `PromptInput.tsx` as well. |
| **Accepting without a match restores the pastes** it remembered. By then they are already the remembered ones. | **Keep.** It is harmless and costs nothing. |
| **`handleKeyDown` duplicates the hook's own listener.** A caller that wired it would see Backspace cancel twice. None does. | **Keep for parity.** The export is contract. Document it on the new export. |
| **The notice for a query of spaces** with nothing listed reads `No matching prompts`. | **Open.** Either wording is acceptable, and it is not pinned. |
| **Empty tool lists add an empty line,** and **a message with several tool-result blocks repeats the tool's output.** Normalized transcript messages carry one block each, so the second cannot happen today. | **Open.** Neither is pinned, and dropping both is allowed. |
| **The paste hash is used as a file name** (outside the unit). | See Security requirements. |

## Outcome (2026-09-28)

- **The gate.** One new file matched Claude Code lines when the unit landed,
  and it was reworded to zero:
  - `src/sessions/hooks/useHistorySearch.test.tsx`, 5 lines. Its harness
    declared the prompt's fields as five separate pieces of React state, a
    run that matched by shape. The harness now holds them as one value and
    hands the hook a setter for each field. Every test and expectation is
    unchanged.
- **Files rewritten at their old paths.** The baseline still allowed them
  their old counts, so the gate did not flag them, and they were reviewed by
  hand. `src/sessions/transcriptSearch.ts` had 7 matching lines: the cache
  lookup, the loop over an assistant's blocks and the object guard matched
  by shape. They are now a lookup that falls back to a function computing and
  storing the text, a `flatMap`, and the guard's two tests in the other order.
  The exported signature is left alone, and a single line is not counted.
  The file measures zero.
- **Residue, reviewed.** 14 lines of Claude Code stay, all in
  `src/sessions/hooks/useHistorySearch.ts`, and all contract: the three
  fields of the hook's result that the prompt reads (`setHistoryQuery`,
  `historyMatch`, `historyFailedMatch`), and the hook's positional
  signature, which its caller passes argument by argument. They go when the
  contract is redesigned, after every consumer has been rewritten.

## Target design

- **The inline search:**
  - **A pure engine.** Given an async source of history entries and a query,
    it yields the next entry whose text contains the query and has not been
    shown in this scan. It tests without React or files.
  - **A scan object per query.** It is created on each query change, and the
    hook applies a result only while the scan is still current. That is the
    fix for the first finding.
  - **The remembered prompt as one value.** Input, cursor, mode and pastes
    make one immutable snapshot, taken when a search starts. Restore and
    cancel both put back all of it, mode included.
  - **The key table.** One table maps the four `historySearch:*` actions and
    the empty-query Backspace to named operations (step, accept, cancel,
    submit). The actions and contexts stay those of
    `src/terminal/keybindings/defaultBindings.ts`. The `history:search`
    binding keeps its `HISTORY_PICKER` gate.
  - **The signature.** The positional parameters stay until `PromptInput.tsx`
    is rewritten. Then they become one options object, with a named result
    type.
- **The picker:**
  - **Pure helpers beside the component,** testable without Ink:
    - the filter and rank of section 3 (trim, lower-case, substring group,
      then characters-in-order group);
    - the row text (age padded to 8, first line cut to the row width);
    - the widths for a terminal width;
    - the preview lines (hard wrap, blanks dropped, a cap of 6 with the
      counter).
  - **The component.** A hand-written function component over the
    design-system `FuzzyPicker` (`src/terminal/design-system/FuzzyPicker.tsx`),
    which provides the query box, the window, the marks, the keys and the
    hint line. It has no React Compiler cache slots, and registers the
    overlay.
  - **Loading.** It reads `getTimestampedHistory()` once per mount, stops
    reading when unmounted, and skips entries without a string `display`.
  - **Row keys** are unique per prompt.
- **The transcript search:**
  - **The same three pure exports.** The field names of section 4's two
    helpers are data (ordered lists), and the per-message contributions are a
    table by message type.
  - **The cache** stays a `WeakMap` keyed by the message object.
  - **Regular expressions,** if any, live at module level.
- **Types.** Explicit throughout, with no `any`. Errors are neither thrown
  into unawaited promises nor swallowed. A skipped history entry is logged
  with `logForDebugging`.
