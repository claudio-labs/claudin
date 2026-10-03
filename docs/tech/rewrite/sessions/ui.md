# Spec: `sessions/ui`

The unit is five files:
- `src/sessions/ui/ResumeConversation.tsx`, the startup session picker of `claudin --resume`;
- `src/sessions/ui/SessionPreview.tsx`, the read-only view of one session that the session list opens;
- `src/sessions/ui/SessionBackgroundHint.tsx`, the owner of Ctrl+B while foreground tasks run;
- `src/sessions/hooks/useSessionBackgrounding.ts`, the REPL's side of an agent task brought to the foreground;
- `src/sessions/hooks/useFileHistorySnapshotInit.ts`, the one-time file-history restore of a resumed session.

## Purpose

**Choosing a session to resume at startup.** `claudin --resume` with no
session id shows a list of the sessions recorded for this repository. The
user picks one, and the REPL opens on that conversation, with the process
taking the session over. A session of another directory is not resumed in
place: the picker prints the command that resumes it there, copies it to the
clipboard, and ends the process. The list itself (rows, search, rename,
preview, keys) is the session list of `src/sessions/ui/SessionsScreen.tsx`.
`ResumeConversation` feeds it the sessions and acts on its choice.

**Previewing a session.** From the session list, Ctrl+V opens
`SessionPreview` on the focused session: the conversation as the transcript
view shows it, and a footer with the session's age, message count and git
branch. Enter resumes it, Esc goes back.

**Backgrounding in the REPL.** While a bash command or an agent runs in the
foreground, Ctrl+B sends it to the background (`SessionBackgroundHint`). An
agent task can also be brought to the foreground in the main view.
`useSessionBackgrounding` then mirrors that task's messages and loading
state into the REPL, and hands the view back when the task ends.

**File history on resume.** `useFileHistorySnapshotInit` gives the REPL, once,
the file-history state rebuilt from the resumed session's snapshots, so the
rewind feature knows the files the session had touched.

The callers:
- `ResumeConversation` is mounted by `launchResumeChooser` in
  `src/terminal/dialogLaunchers.tsx`, inside `<App>` and `<KeybindingSetup>`.
  That launcher is called by `src/platform/main/defaultAction/resume.ts`
  with the session configuration, `initialSearchQuery` (the `--resume`
  search term), `forkSession` (`--fork-session`), `filterByPr` (`--from-pr`)
  and the worktree paths of the current repository (`getWorktreePaths`).
- `SessionPreview` is rendered by `src/sessions/ui/SessionsScreen.tsx` on
  Ctrl+V.
- The other three are used by `src/agent/repl/REPL.tsx`.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `ResumeConversation` | React component, props below; returns a React node | `src/terminal/dialogLaunchers.tsx` (type and dynamic import) |
| `SessionPreview` | React component taking `{ log: LogOption; onExit: () => void; onSelect: (log: LogOption) => void }` | `src/sessions/ui/SessionsScreen.tsx` |
| `SessionBackgroundHint` | React component taking `{ onBackgroundSession: () => void; isLoading: boolean }`; renders nothing | `src/agent/repl/REPL.tsx` |
| `useSessionBackgrounding` | `(props: { setMessages: (messages: Message[] \| ((prev: Message[]) => Message[])) => void; setIsLoading: (loading: boolean) => void; resetLoadingState: () => void; setAbortController: (controller: AbortController \| null) => void; onBackgroundQuery: () => void }) => { handleBackgroundSession: () => void }` | `src/agent/repl/REPL.tsx` |
| `useFileHistorySnapshotInit` | `(initialFileHistorySnapshots: FileHistorySnapshot[] \| undefined, fileHistoryState: FileHistoryState, onUpdateState: (newState: FileHistoryState) => void) => void` | `src/agent/repl/REPL.tsx` |

`ResumeConversation`'s props:

| Prop | Type | Use |
|---|---|---|
| `commands`, `initialTools`, `debug`, `thinkingConfig` | `Command[]`, `Tool[]`, `boolean`, `ThinkingConfig` | passed to the REPL |
| `mcpClients`, `dynamicMcpConfig`, `strictMcpConfig` (default `false`), `systemPrompt`, `appendSystemPrompt`, `autoConnectIdeFlag`, `disableSlashCommands` (default `false`), `taskListId`, `onTurnComplete` | optional | passed to the REPL |
| `mainThreadAgentDefinition` | `AgentDefinition`, optional | the agent of the command line, weighed against the session's own (behaviour 2.3) |
| `worktreePaths` | `string[]` | the directories whose sessions are "this repository" |
| `initialSearchQuery` | `string`, optional | the list starts filtered by it |
| `forkSession` | `boolean`, optional | open the conversation without taking the session over |
| `filterByPr` | `boolean \| number \| string`, optional | behaviour 1.4 |

Where the types come from:
- `LogOption` is in `src/shared/types/logs.ts`;
- `Message` is in `src/shared/types/message.ts`;
- `FileHistorySnapshot` and `FileHistoryState` are in `src/shared/fs/fileHistory.ts`;
- the REPL prop types are those of `src/agent/repl/REPL.tsx`.

**The module paths are contract.** `src/agent/repl/__testutils__/replTestHarness.ts`
replaces `src/sessions/hooks/useFileHistorySnapshotInit.js` by path with
`mock.module`, so that file must keep its path and export name.

**Collaborators.** The unit uses these exports of other modules rather than
reimplementing them:

| What | Defined by |
|---|---|
| the session list: rows, search, rename, Ctrl+A/Ctrl+B/Ctrl+V/Ctrl+R, Esc, confirmations, its hints | `SessionsScreen` in `src/sessions/ui/SessionsScreen.tsx` |
| the sessions of the given worktrees, then of every project, enriched in pages | `loadSameRepoMessageLogsProgressive`, `loadAllProjectsMessageLogsProgressive`, `enrichLogs` in `src/sessions/sessionStorage.ts` (from `src/sessions/indexing/`) |
| reading a listed session's conversation | `isLiteLog`, `loadFullLog`, `getSessionIdFromLog` (same barrel) |
| loading a conversation for resume, with the 8 MiB limit and the resume hooks | `loadConversationForResume` in `src/sessions/conversationRecovery.ts` |
| whether a session belongs to another directory, and the command to resume it there | `checkCrossProjectResume` in `src/sessions/crossProjectResume.ts` |
| the clipboard (OSC 52, tmux buffer, native tool) | `setClipboard` in `src/terminal/ink/termio/osc.ts` |
| taking a session over | `switchSession` (`src/platform/bootstrap/state.ts`), `resetSessionFilePointer`, `adoptResumedSessionFile`, `restoreSessionMetadata` (`src/sessions/sessionStorage.ts`), `restoreCostStateForResume` (`src/agent/cost-tracker.ts`), `renameRecordingForSession` (`src/terminal/image/asciicast.ts`), `updateSessionName` (`src/sessions/concurrentSessions.ts`) |
| the agent, the agent context and the worktree of a resumed session | `restoreAgentFromSession`, `computeStandaloneAgentContext`, `restoreWorktreeForResume` in `src/sessions/sessionRestore.ts` |
| coordinator mode (shipped build only) | `matchSessionMode`, `isCoordinatorMode` in `src/agent/coordinator/coordinatorMode.ts`; `getAgentDefinitionsWithOverrides`, `getActiveAgentsFromList` in `src/tools/AgentTool/loadAgentsDir.ts`; `saveMode` in `src/sessions/sessionStorage.ts` |
| the conversation view | `Messages` in `src/agent/ui/Messages.tsx` |
| foreground tasks | `hasForegroundTasks`, `backgroundAll` in `src/agent/tasks/LocalShellTask/LocalShellTask.tsx` |
| the file-history state of a session's snapshots | `fileHistoryEnabled`, `fileHistoryRestoreStateFromLog` in `src/shared/fs/fileHistory.ts` |
| key bindings | `useKeybinding` (`src/terminal/keybindings/useKeybinding.ts`) over `src/terminal/keybindings/defaultBindings.ts` |

## Observable behaviour

### 1. The startup picker: the list

1. **Loading.** Until the first page of sessions arrives, the picker shows a
   spinner and ` Loading conversations…`.
2. **What is listed.** The sessions recorded under the project directories
   of `worktreePaths`, as the loader returns them: newest first by the
   transcript's modification time, at most 50 at first. A sidechain session
   is never listed.
3. **Nothing to list.** With no session left after filtering, the picker
   shows two lines instead of the list: `No conversations found to resume.`
   and `Press Ctrl+C to exit and start a new conversation.`. Ctrl+C (the
   `app:interrupt` action, context `Global`) ends the process with exit
   code 1. Ctrl+A does nothing on this screen (Findings).
4. **`filterByPr`.**

   | Value | Listed |
   |---|---|
   | absent | every session |
   | `true` | sessions linked to a PR |
   | a number `n` | sessions linked to PR `n` |
   | text that parses as a positive integer (`"17"`) | sessions linked to that PR |
   | text containing `github.com/<owner>/<repo>/pull/<n>` | sessions linked to PR `n` |
   | any other text (including `"0"` and `"-17"`) | every session: no filter |

   A filter that matches nothing gives the empty screen of 1.3.
5. **The list is `SessionsScreen`**, given: the filtered sessions; the
   terminal's row count as its height; `initialSearchQuery`; whether every
   project is shown; and the handlers below. Its rows, header (`Sessions (i
   of n)`, `· all projects`), hints and keys are that component's.
6. **Ctrl+A** toggles between this repository's sessions and every
   project's. Each toggle reloads the list from disk, from the first page.
   The header shows `· all projects` and the hint changes from `Ctrl+A all
   projects` to `Ctrl+A this project`.
7. **More pages.** When the list asks for more (as the focus nears the end),
   the next sessions are read from where the last page stopped and appended,
   until none remain. A page that yields no listable session moves on to the
   next one.
8. **Rename.** After a rename in the list, the list is reloaded from disk in
   the current scope, so the new title shows.
9. **Esc** (and the list's own double Ctrl+C/Ctrl+D) ends the process with
   exit code 1 and resumes nothing. The list's `keepRunning` argument is
   ignored: nothing runs yet at startup.

### 2. The startup picker: choosing a session

1. **Another directory.** Only with every project shown: a session whose
   project path is set and differs from the original working directory is
   not resumed. The picker:
   - copies the command from `checkCrossProjectResume` to the clipboard, and
     writes the clipboard's terminal sequence to the process's stdout. With
     no tmux, that is exactly `ESC ] 52 ; c ; <base64 of the command> BEL`
     (`ST` instead of `BEL` under kitty);
   - replaces the screen with three blocks, separated by blank lines:
     `This conversation is from a different directory.`; `To resume, run:`
     followed by the command on its own line, indented by one space;
     `(Command copied to clipboard)`;
   - ends the process with exit code 0, 100 ms after that screen mounts.

   The command has the form `cd <shell-quoted project path> && <binary>
   --resume <session id>`. The binary name is the collaborator's (Findings).
   If the check ever reports a sibling worktree of the same repository, the
   session is resumed in place instead. Today it never does (Findings).
2. **Resuming.** Any earlier error is cleared, and the picker shows a
   spinner and ` Resuming conversation…` while the conversation loads.
3. **What resuming does,** in this order of effect, unless `forkSession` is
   set:
   - the process switches to the session's id, with the session's project
     directory set to the directory holding its transcript; a terminal
     recording in progress is renamed to the session; the session file
     pointer is reset; the session's cost so far is restored;
   - the agent is resolved from the session's agent setting, the command
     line's agent and the defined agents (`restoreAgentFromSession`), and
     `agent` in the app state is set to its type (undefined when there is
     none, or when the session's agent is no longer defined);
   - when the session has an agent name or colour, `standaloneAgentContext`
     in the app state is set from them (`computeStandaloneAgentContext`);
     otherwise it is left alone;
   - the session name is updated to the agent name (fire and forget);
   - the session's metadata (title, tag, agent name, colour and setting,
     mode, worktree, PR link) is restored into the session state;
   - the process returns to the session's worktree, if it had one
     (`restoreWorktreeForResume`), and adopts the session's transcript as
     the file it writes to.

   With **`forkSession`**: the conversation, the agent, the agent context and
   the metadata are restored as above, but the process keeps its own session
   id, its own cost and its own transcript, does not enter the worktree, and
   the restored metadata carries no worktree.
4. **Coordinator mode (shipped build only;** the `COORDINATOR_MODE` build
   flag is on in `scripts/build/build.ts` and off under `bun test`). When the
   session was recorded in the other mode than the current one, before the
   steps of 2.3: the process switches mode to match; the agent definitions
   are reloaded from the original working directory, bypassing their cache,
   and replace `agentDefinitions` in the app state, with the active agents
   recomputed; and a warning system message is appended to the
   conversation: `Entered coordinator mode to match resumed session.` or
   `Exited coordinator mode to match resumed session.` (the collaborator's
   text). After the agent is restored, the current mode (`coordinator` or
   `normal`) is saved to the session.
5. **The REPL opens** in place of the picker, with the conversation's
   messages, its file-history snapshots, its agent name, its agent colour
   (none when the stored colour is `default`), the resolved agent as
   `mainThreadAgentDefinition`, and every pass-through prop.
6. **Failure.** When loading the conversation throws (for instance a
   transcript over the 8 MiB resume limit), or yields nothing, the error is
   logged and the list comes back with a banner above it, on three lines:
   `Failed to resume conversation.` (error colour), the error's message, and
   `Choose a different conversation to continue.` (dim). Nothing has been
   taken over: the session id is unchanged. Choosing again clears the banner.

### 3. `SessionPreview`

1. **Reading.** Given an entry that has a session id and no messages (as the
   list hands it over), the preview reads the conversation from the entry's
   transcript. Until it has, it shows `Loading session…` and the hint `Esc
   to cancel`. An entry that already has messages is shown at once.
2. **The view.** The conversation as the transcript view shows it (verbose,
   every message), followed by a footer with a top border, indented by two:
   - `<age> · <n> messages` and, when the session has a git branch,
     ` · <branch>`. The age is the relative time of the session's last
     modification (`30m ago`); `n` is the session's message count;
   - the hint `Enter to resume · Esc to cancel`.
3. **Keys** (context `Confirmation`): `confirm:yes` (Enter) calls `onSelect`
   with the conversation as read, or with the entry it was given if nothing
   was read; `confirm:no` (Esc) calls `onExit`. Esc works while loading too.
4. **A new entry** replaces the old one: the preview reads and shows the new
   session, and Enter hands back the new one.
5. **A transcript that is gone.** The read gives back the entry unchanged:
   the view shows no message, the footer reads `0 messages`, and Enter still
   hands back the entry.

### 4. `SessionBackgroundHint`

1. **It renders nothing.**
2. **Ctrl+B** (`task:background`, context `Task`) is bound only while there
   is foreground work: a bash task not yet backgrounded that still has its
   shell command, or an agent task not yet backgrounded that is not the main
   session's.
3. **On Ctrl+B,** unless `CLAUDIN_DISABLE_BACKGROUND_TASKS` is truthy: every
   foreground task is sent to the background (`backgroundAll`). An agent
   task's background signal resolves. The first time, the global config gets
   `hasUsedBackgroundTask: true`; once it is set, it stays set.
4. **Its props are not read** (Findings).

### 5. `useSessionBackgrounding`

The hook watches `foregroundedTaskId` in the app state and the task it names.
It acts only through the callbacks it is given and through the app state.

1. **Nothing foregrounded.** `handleBackgroundSession` calls
   `onBackgroundQuery` and nothing else.
2. **An agent task foregrounded, running:**
   - its messages are sent to the main view with `setMessages`, as a new
     array, whenever their count differs from the count last sent (a change
     that keeps the count is not sent; a task with no messages sends
     nothing);
   - `setIsLoading(true)`;
   - if the task has an abort controller, `setAbortController(controller)`.
3. **`handleBackgroundSession` with a task foregrounded:** the task is marked
   backgrounded and `foregroundedTaskId` is cleared (just cleared if the task
   is gone). Then `setMessages([])`, `resetLoadingState()` and
   `setAbortController(null)`. `onBackgroundQuery` is not called.
4. **The foregrounded task finishes** (any status but `running`), or **is
   aborted** (its controller's signal is aborted, seen at the next change of
   the task): the task is marked backgrounded, `foregroundedTaskId` is
   cleared, then `resetLoadingState()` and `setAbortController(null)`. The
   main view's messages are left as they are.
5. **A foregrounded id that names no task, or a task that is not an agent:**
   `foregroundedTaskId` is cleared and `resetLoadingState()` is called.
6. **The count restarts** whenever nothing is foregrounded, or after 4 or 5:
   a task foregrounded again has its messages sent afresh.

### 6. `useFileHistorySnapshotInit`

1. **Once.** The first time it runs with file history enabled, and only
   then, it marks itself done. If snapshots were given, `onUpdateState` is
   called with the state rebuilt from them (`fileHistoryRestoreStateFromLog`):
   - `snapshots`: the same snapshots, with each tracked path shortened
     relative to the working directory;
   - `trackedFiles`: the set of those shortened paths;
   - `snapshotSequence`: the number of snapshots.

   An empty list gives `{ snapshots: [], trackedFiles: ∅, snapshotSequence: 0 }`.
2. **Never again** for that mount: later changes of the snapshots, of the
   state or of the callback call nothing.
3. **Disabled.** File history is enabled when the session is interactive,
   the global config does not set `fileCheckpointingEnabled: false`, and
   `CLAUDIN_DISABLE_FILE_CHECKPOINTING` is not truthy. A non-interactive
   session needs `CLAUDIN_ENABLE_SDK_FILE_CHECKPOINTING` instead. While
   disabled, nothing happens and the hook is not done: if file history is
   enabled later, the next change of its inputs runs step 1.
4. **No snapshots** on the first enabled run: nothing is called, and the hook
   is done. Snapshots given later are ignored.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| No session at all in the worktrees | the empty screen; Ctrl+C exits 1 | yes |
| No session here, sessions in other projects | the empty screen; Ctrl+A does nothing | no: a defect, see Findings |
| `filterByPr` names a PR no session links to | the empty screen | yes |
| `filterByPr` is text that names no PR, or a non-positive number as text | no filtering | yes |
| A sidechain transcript | never listed | yes |
| More than 50 sessions | the newest 50, then the rest as the focus nears the end | yes |
| Several worktree paths | the sessions of each | yes |
| The loader rejects | logged; the empty screen | no: the loaders catch their own errors, so it cannot be provoked |
| A transcript over 8 MiB | the failure banner, list kept, nothing taken over | yes |
| A session of another directory, every project shown | command shown, copied, exit 0 | yes |
| A session of this directory, every project shown | resumed in place | yes |
| A session whose agent is no longer defined | resumed with no agent | yes |
| A session with no agent name or colour | the agent context is left alone | yes |
| A session with a worktree | resumed into it; a fork stays put | yes |
| A transcript deleted after the list was drawn | preview: `0 messages`; picker: the REPL opens on an empty conversation under that session's id | preview: yes; picker: no |
| Coordinator-mode mismatch | the mode flips and a warning message is added | no: the flag is off under `bun test` |
| Ctrl+B with nothing in the foreground | nothing | yes |
| `CLAUDIN_DISABLE_BACKGROUND_TASKS` set | Ctrl+B does nothing | yes |
| A foregrounded id with no task, or a non-agent task | foreground cleared | yes |
| File history turned on after mount | restored at the next input change | yes |

## Security requirements

- **A session of another directory is never resumed in place.** Resuming
  it would run its tools in the wrong working tree. The picker only prints
  the command, and the user runs it. Pinned.
- **The command is shell-quoted** by the collaborator (`quote` in
  `src/platform/bash/shellQuote.ts`), so a project path with spaces or shell
  characters is copied and shown as one argument. The rewrite must keep
  quoting it. Not pinned with a hostile path; the suite pins the plain form.
- **The clipboard.** The command goes to the terminal as OSC 52. Over SSH
  (`SSH_CONNECTION` set) no native clipboard tool is run, so the copy does not
  land on the remote machine's clipboard. Inside tmux, the tmux buffer is
  loaded and the sequence is wrapped for passthrough. This is the
  collaborator's policy and stays there.
- **The resume size limit** (8 MiB) and the resume hooks are the loader's.
  The picker must surface their errors and take nothing over when they
  throw. Pinned.
- **The kill switch.** `CLAUDIN_DISABLE_BACKGROUND_TASKS` must keep Ctrl+B
  from backgrounding anything. Pinned.

## Tests that pin it

- **`src/sessions/ui/ResumeConversation.characterization.test.tsx`.** 26
  tests on the picker: the list, its scope, the PR filter, the search query,
  Esc and Ctrl+C, rename, paging, resume, fork, cost, worktree, agent, agent
  context, failure, the cross-project path and the preview path.
- **`src/sessions/ui/SessionPreview.characterization.test.tsx`.** 8 tests.
- **`src/sessions/hooks/sessionBackgrounding.characterization.test.tsx`.** 19
  tests: 5 on the hint, 9 on the backgrounding hook, 5 on the file-history
  hook.
- **Coverage** of the three suites together (53 tests, about 19 s, three
  green runs in a row): 88% of the lines of `ResumeConversation.tsx` (the
  rest is the coordinator branch, the unreachable worktree branch, the
  loader's error paths and the empty page), 99% of `SessionPreview.tsx` and
  `useSessionBackgrounding.ts`, 100% of the other two.
- **The fixture, `src/sessions/ui/__fixtures__/rewrite/resume/parser-rewrite.jsonl`.**
  A transcript written on 2026-10-03 by the real session writer in a git
  repository on branch `parser-fix`, with the project path then rewritten to
  `/work/fixture`. Session id `aeff62ea-64ed-4fe8-988a-8b604b28e83c`; three
  messages (`Let us fix the parser.`, `On it.`, `That is all for now.`); the
  title `Parser rewrite`; agent name `reviewer`, colour `blue`; a link to PR
  17 of `acme/app`; one file-history snapshot. The suites copy it under the
  temp config directory as sessions of the test's project, rewriting the id,
  title, PR link, branch, sidechain flag or age, or appending one user
  message.
- **The rig, `src/sessions/ui/__testutils__/resumeRig.tsx`.** The rewrite
  has to keep working under it:
  - **The world.** `useBootSandbox` from
    `src/platform/main/__testutils__/bootHarness.ts`: a temp
    `CLAUDIN_CONFIG_DIR`, project, `CLAUDIN_TMPDIR`, and a local
    OpenAI-compatible provider profile. On top: `SSH_CONNECTION` set and
    `TMUX`/`STY` unset (so a copy is only the OSC 52 sequence), marketplace
    auto-install and non-essential traffic off, `MACRO` set on `globalThis`,
    `process.exit` recorded instead of run, and `process.stdout.write`
    captured.
  - **The mount.** A real Ink root on the fake terminal
    (`src/terminal/__testutils__/fakeTerminal.ts`), 120 columns by 24 rows,
    `exitOnCtrlC: false`, with `<App>` and `<KeybindingSetup>` around the
    component, as `launchResumeChooser` mounts it. The app store is read and
    written through a probe inside the provider.
  - **Keys** go in as raw bytes: `\r`, `\x1b`, `\x1b[B`, `\x01` (Ctrl+A),
    `\x02` (Ctrl+B), `\x03` (Ctrl+C), `\x12` (Ctrl+R), `\x16` (Ctrl+V). The
    suites wait about 150 ms after the list appears before the first key,
    because a key sent before the handlers subscribe is lost.
  - **The REPL is up** once `? for shortcuts` is on screen.
  - **Tasks** are registered with `registerAgentForeground` and edited through
    the store. The REPL's setters are recorders.
- **`scripts/migrations/probes/rewrite-sessions-ui.json`.** 39 probes: 20 on
  the picker, 5 on the preview, 4 on the hint, 7 on the backgrounding hook
  and 3 on the file-history hook. Every one turns the suites red.
- **Other tests through the contract:**
  `src/terminal/dialogLaunchers.characterization.test.tsx` mounts the picker
  through its launcher (empty list, order, `filterByPr`, `initialSearchQuery`).
  The REPL suites mock `useFileHistorySnapshotInit` away.
- **Not pinned, and why:**
  - **Coordinator mode** (2.4): `feature()` is always false under `bun test`.
  - **The pass-through REPL props** other than the messages and the agent
    context, the agent colour `default`, the recording rename and the
    session-name update: none is observable without driving the REPL itself.
  - **The same-repo-worktree branch** of 2.1: the check never takes it.
  - **A page of sessions that yields nothing** (1.7): it needs a run of 40
    unlistable transcripts past the first 50.
  - **A loader that rejects:** the loaders catch their own errors.
  - **A bash task** in the foreground for the hint: it needs a live shell
    command. The agent path covers the hint's own logic.
  - **Styling:** colours, dim text, the spinner.
  - **The defects marked Fix** in Findings, whose old behaviour must not be
    carried over.
- **Prompt text.** The unit sends nothing to a model, so no file outside the
  unit pins prompt text for it.

## Out of scope

Nothing the unit does is dropped. The session list, the loaders, the resume
loader, the cross-project check and the clipboard are collaborators, and keep
their own behaviour.

## Findings

| Finding | Decision |
|---|---|
| **The cross-project command names `claude`,** not `claudin` (`src/sessions/crossProjectResume.ts`, outside the unit). Run as shown, it starts another product, or nothing. | **Fix,** in that module. No stored data depends on the text. The suite pins only `cd <path> && ` and ` --resume <id>`, so the fix does not touch it. |
| **The same-repo-worktree branch is unreachable.** `checkCrossProjectResume` ignores the worktree paths and never reports a sibling worktree. So, with every project shown, a session of a sibling worktree gives the `cd` command, while the same session resumes in place from the default scope (where it is listed through `worktreePaths`). | **Keep for parity** in this unit: it keeps routing on the check's answer, and resumes in place when the check reports a sibling worktree. Teaching the check about worktrees belongs to that module's rewrite. |
| **No way to the other projects from the empty screen.** With no session in this repository, the picker shows the two-line message and Ctrl+A does nothing, so the sessions of other projects cannot be reached. | **Fix.** The empty case shows the list's own empty state (`No sessions yet.`) with Ctrl+A available. Nobody can depend on not reaching them. Pin it in the new module's tests: with sessions only elsewhere, Ctrl+A lists them. |
| **`handleBackgroundSession` is never called in the shipped REPL.** The REPL passes it only to `SessionBackgroundHint` as `onBackgroundSession`, and the hint reads neither of its props. So "send the foregrounded agent back" and "background the current query" cannot be reached by a key. | **Keep for parity.** Both exports and their props are contract. Wiring Ctrl+B to it is a REPL decision, taken when the REPL is rewritten. |
| **The picker's own sidechain filter never removes anything:** the loaders already drop sidechains. | **Keep.** The rewrite may rely on the loader, as long as no sidechain is listed (pinned). |
| **Cancelling the picker exits with 1,** and the cross-project path with 0. Both end the process directly, without the graceful shutdown. | **Keep for parity.** Scripts may read the exit codes, and nothing has been written yet at that point. |
| **Switching the foreground straight from one agent task to another** (without releasing it in between) sends the second task's messages only if their count differs from the first's: the count of what was sent is not tied to a task. With equal counts the main view keeps showing the first task's messages. | **Fix.** The count belongs to the task it was taken from; a different task is always sent in full. No caller can depend on seeing another task's messages. Not pinned. |
| **A preview whose entry changes while a read is in flight** can show the first session if its read finishes last: reads are not cancelled. | **Fix.** Only the read for the current entry may land. Pure correctness; not pinned. |
| **A transcript deleted between listing and choosing** opens the REPL on an empty conversation under the session's id, instead of an error. The loader returns the entry unchanged when the read fails. | **Keep for parity.** A metadata-only session (listed as `(session)`) legitimately has no messages, so "no messages" is not an error the picker can tell apart. Revisit with the loader. |

## Target design

- **`ResumeConversation`.** A hand-written function component (no React
  Compiler cache slots) over `SessionsScreen`, split into:
  - **A pure filter** `(logs, filterByPr) => logs`, with the PR-identifier
    parser beside it (positive integer, or a GitHub pull URL). Tested
    without Ink.
  - **A list hook** that owns the scope (this repository or every project),
    the loaded pages and the "load more" continuation, and exposes
    `{ logs, loading, toggleScope, reload, loadMore }`. One loader call per
    scope; a page that yields nothing continues to the next.
  - **A resume action** `(log, options) => Promise<ResumeOutcome>`, where
    `ResumeOutcome` is `{ kind: 'resumed', data }`, `{ kind: 'elsewhere',
    command }` or `{ kind: 'failed', message }`. It performs the steps of
    2.3 and 2.4 as a table of named steps, each skipped under `forkSession`
    where 2.3 says so. The coordinator steps stay behind
    `feature('COORDINATOR_MODE')`.
  - **The view** renders one of: loading, resuming, the cross-project
    screen, the REPL, or the list with an optional error banner. The empty
    state is the list's own (Findings).
  - **Exits** go through one injected function, so the screens that end the
    process can be tested without trapping `process.exit`.
- **`SessionPreview`.** A plain component with a small read hook: it reads
  the entry when it has no messages, drops a result for an entry that is no
  longer current, and returns `{ log, loading }`. The footer text is a pure
  function `(log) => string`.
- **`SessionBackgroundHint`.** A plain component that binds `task:background`
  while `hasForegroundTasks` holds, honours the kill switch, calls
  `backgroundAll`, and records the first use. Its props stay until the REPL is
  rewritten.
- **`useSessionBackgrounding`.** The three "send back" updates (handler,
  finish, abort) become one pure state transition, `(state, taskId) =>
  state`, shared by all three. The message mirror keeps a count of what it
  last sent and resets it whenever the foreground is released.
- **`useFileHistorySnapshotInit`.** Unchanged in shape: a ref that becomes
  true on the first enabled run, keeping its path and signature.
- **Types.** Explicit throughout, with no `any`. Errors are logged with
  `logError` and surfaced, never swallowed.

## Landing notes (2026-10-03)

This suite was characterized against `6e89dbbb`. It landed after
`sessions/liteMetadata` and `sessions/resume` had been rewritten, and two of its
pins caught differences:
- **A regression, fixed.** The rewritten full load took `gitBranch` from the
  newest message alone, so a reply written without a branch dropped the
  session's branch from the preview footer. It now takes the newest branch the
  chain names, and falls back to the listed one. A probe in this spec guards it.
- **Wording.** The size-refusal text is owned by `sessions/resume`, whose spec
  fixes only the fact that the transcript is "too large to resume". This suite
  had pinned the old sentence, "too large to resume safely"; it now checks the
  fact.

## Outcome

Rewritten per method on 2026-10-03.
- **Code.** The five files are now thin facades. The picker lives in
  `ui/resumePicker/`, with the resume steps as a named table. The preview's
  read lives in `ui/sessionPreview/useSessionRead.ts`, and the
  foreground/background moves in `hooks/sessionBackgrounding/foreground.ts`.
  No React Compiler bookkeeping is left. The three characterization suites
  pass unchanged.
- **Fixes, each tested.**
  - The empty screen offers Ctrl+A with a hint.
  - Switching straight between agents sends the new agent in full.
  - The preview drops a read for an entry that is no longer current.
  - The cross-project command runs `claudin --resume`.
- **Kept, because the unchanged suite pins it.** The empty screen still says
  "No conversations found to resume." and exits with code 1.
- **Probes.** `rewrite-sessions-ui.json` holds 67 probes, among them the branch
  fallback in `liteMetadata.ts`.
- **Residue, reviewed.** 53 lines of Claude Code remain. 18 are
  `ResumeConversation`'s props type. The rest are the props and parameter types
  of the hooks and components, plus `releaseForeground`'s immutable state
  update. Its shape converges with the original, and the implementer never saw
  that original.
