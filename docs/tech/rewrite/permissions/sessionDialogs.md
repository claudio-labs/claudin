# Spec: `permissions/sessionDialogs`

Files: `permissions/ui/trust/TrustDialog.tsx`, `permissions/ui/trust/utils.ts`,
`permissions/ui/WorktreeExitDialog.tsx`, `permissions/ui/CostThresholdDialog.tsx`.

## Purpose

Three dialogs that stand at the edges of an interactive session, and the
checks behind the first one.
- **The workspace-trust dialog.** It is the question an interactive session asks before anything a folder brings is allowed to run: hooks, helpers, environment variables, project MCP servers. Startup asks it once per folder. Trusting is remembered for the project. Every other answer ends the process.
- **The trust checks** (`trust/utils.ts`) answer seven questions about what a checkout's own settings files would run, each answered with the files that bring it.
- **The worktree exit dialog.** `/exit` shows it when the session is inside a worktree. It keeps the worktree, or removes it with its branch, and brings the session back to where it started.
- **The cost notice.** The REPL shows it once a session's spend passes $5.

The security question for this unit: no answer, and no file in the folder,
may mark a folder trusted without the user choosing "Yes", and no exit path
may delete work the user did not choose to discard.

No text in this unit is sent to a model.

## Public contract

| Export | Signature | Used by |
|---|---|---|
| `TrustDialog` | component, props `{ onDone(): void; commands?: Command[] }` | `terminal/interactiveHelpers.tsx` (`showSetupScreens`, when the active provider uses the Anthropic account flow and the folder is not yet trusted; it passes the session's commands) |
| `getHooksSources` | `() => string[]` | `TrustDialog` |
| `getBashPermissionSources` | `() => string[]` | `TrustDialog` |
| `getApiKeyHelperSources` | `() => string[]` | `TrustDialog` |
| `getAwsCommandsSources` | `() => string[]` | `TrustDialog` |
| `getGcpCommandsSources` | `() => string[]` | `TrustDialog` |
| `getOtelHeadersHelperSources` | `() => string[]` | `TrustDialog` |
| `getDangerousEnvVarsSources` | `() => string[]` | `TrustDialog` |
| `WorktreeExitDialog` | component, props `{ onDone(result?: string, options?: { display?: CommandResultDisplay }): void; onCancel?(): void }` | `platform/ExitFlow.tsx` (reached from `commands/exit/exit.tsx` and `agent/repl/hooks/useReplExit.tsx`; `onDone` prints the message and shuts down with code 0, `onCancel` returns to the prompt) |
| `CostThresholdDialog` | component, props `{ onDone(): void }` | `agent/repl/ui/REPLDialogs.tsx` (mounted when the focused dialog is `cost`; `onDone` records `hasAcknowledgedCostThreshold` in the user config), imported by `agent/repl/REPL.tsx` |

Collaborators the rewrite must use, not restate:
- `checkHasTrustDialogAccepted`, `saveCurrentProjectConfig` and `getProjectPathForConfig` (`platform/config/config.ts`) decide what counts as trusted and where trust is written;
- `setSessionTrustAccepted` (`platform/bootstrap/state.ts`) is the session-only latch;
- `getSettingsForSource` and `getPermissionRulesForSource` read the settings files;
- `SAFE_ENV_VARS` (`platform/config/managedEnvConstants.ts`) is the list of safe variables;
- `PermissionDialog` (`permissions/promptFrame`) and `Dialog` (`terminal/design-system`) are the frames;
- `keepWorktree`, `cleanupWorktree`, `killTmuxSession`, `getCurrentWorktreeSession` (`vcs/git/worktree.ts`) do the worktree work;
- `getAPIProvider` (`providers/model/providers.ts`) names the provider.

## Observable behaviour

### 1. What the trust dialog shows

Inside the promptFrame frame (`PermissionDialog`, warning colour), top to
bottom:
- the title `Accessing workspace:`;
- the folder: the process's working directory, in bold, on its own line;
- the generic warning. It must state that this is a safety check, ask whether this is a project the user created or trusts, give the three examples (your own code, a well-known open source project, work from your team), and ask the user to review what is in the folder first if not;
- `Claudin will be able to read, edit, and execute files here.`;
- `Security guide`, a hyperlink to `https://code.claude.com/docs/en/security`;
- two numbered answers, `1. Yes, I trust this folder` (focused) and `2. No, exit`;
- the footer `Enter to confirm · Esc to cancel`. After a first Ctrl+C or Ctrl+D it reads `Press <key> again to exit`.

Today the text is the same whatever the folder holds, and the `commands`
prop changes nothing on screen (finding 1).

### 2. The answers

| Answer | Effect |
|---|---|
| Enter on the focused first answer, or `1` | trust (below), then `onDone()` once |
| `2`, or Enter after moving to "No, exit" | the process ends with exit code 1. `onDone` is not called, and nothing is written |
| Esc | the same: exit code 1 (the list's cancel picks "No, exit") |
| `n` | the process ends with exit code **0**, and nothing is written |
| Ctrl+C twice (or Ctrl+D twice) | exit code 1 |
| Ctrl+C once | nothing: the footer asks for a second press |

**Trusting** records, before `onDone()` is called:
- **in the home directory** (the session cwd equals the user's home directory): the session-only latch is raised. Nothing is written to disk, so the question comes back next session;
- **anywhere else:** `hasTrustDialogAccepted: true` is written to the project's entry in the user config file (`<config dir>/config.json`, under `projects["<key>"]`). The key is the canonical git root when the folder is inside a repository, else the folder. The session-only latch stays down. Nothing is written into the folder itself.

### 3. When the folder is already trusted

If `checkHasTrustDialogAccepted()` is already true, the dialog draws nothing
and calls `onDone()` once, on a later tick. That happens when:
- the project's key is recorded as trusted;
- any ancestor of the session cwd is recorded as trusted;
- the session-only latch is up.

**What never counts as trust:**
- anything inside the folder. That covers its `.claudin/settings.json` and `.claudin/settings.local.json` (even with `hasTrustDialogAccepted` or a `projects` map in them), and files shaped like the user config (`.claudin.json`, `.claudin/config.json`);
- trust recorded for a directory inside the folder, or for a sibling.

Only the user config file, outside the checkout, and the session latch decide.

### 4. The trust checks (`trust/utils.ts`)

Each check reads the folder's two settings files and returns the labels of the
files that bring the thing, shared file first:
`'.claudin/settings.json'`, then `'.claudin/settings.local.json'`. Labels are
these literal relative strings, not paths. The user's own settings, the
`--settings` file and managed settings are never counted. A malformed file
counts as bringing nothing. The files are read whatever setting sources the
session loads (`--setting-sources`).

| Check | A file is named when it has |
|---|---|
| `getHooksSources` | at least one hook event with a non-empty list, or a `statusLine`, or a `fileSuggestion`; all three are ignored when the same file sets `disableAllHooks: true` (the other file is unaffected) |
| `getBashPermissionSources` | an **allow** rule for `Bash` or `Bash(<anything>)`. Deny and ask rules, and tools whose name merely starts with `Bash` (`BashOutput`), do not count |
| `getApiKeyHelperSources` | a non-empty `apiKeyHelper` |
| `getAwsCommandsSources` | `awsAuthRefresh` or `awsCredentialExport` (the file is named once) |
| `getGcpCommandsSources` | `gcpAuthRefresh` |
| `getOtelHeadersHelperSources` | `otelHeadersHelper` |
| `getDangerousEnvVarsSources` | an `env` key not in `SAFE_ENV_VARS`, compared upper-cased (a safe name in lower case is still safe). An empty `env` counts as nothing |

### 5. The worktree exit dialog

On mount, with a worktree session, it counts the uncommitted entries
(`git status --porcelain` in the session cwd, untracked files included) and
the commits since the session's start commit (`<start>..HEAD`).

- **Nothing to lose** (no entries, no commits): it removes the worktree and its branch without asking. It reports `Worktree removed (no changes)`.
- **Otherwise it asks.** The title is `Exiting worktree session`, and the subtitle depends on what would be lost (N and M are counts, singular at 1):

  | Uncommitted | Commits | Subtitle |
  |---|---|---|
  | N > 0 | 0 | `You have N uncommitted file(s). These will be lost if you remove the worktree.` |
  | 0 | M > 0 | `You have M commit(s) on <branch>. The branch will be deleted if you remove the worktree.` |
  | N > 0 | M > 0 | `You have N uncommitted file(s) and M commit(s) on <branch>. All will be lost if you remove.` |

  The answers depend on whether the session has a tmux session. Keep is first and focused, and every remove answer is described as `All changes and commits will be lost.`.

  | tmux | Answers (label, then description) |
  |---|---|
  | none | `Keep worktree`, `Stays at <path>`. Then `Remove worktree` |
  | `<name>` | `Keep worktree and tmux session`, `Stays at <path>. Reattach with: tmux attach -t <name>`. Then `Keep worktree, kill tmux session`, `Keeps worktree at <path>, terminates tmux session.`. Then `Remove worktree and tmux session` |

| Answer | Effect | Message to `onDone` |
|---|---|---|
| keep | worktree, branch and changes stay | `Worktree kept. Your work is saved at <path> on branch <branch>` (with tmux: then `. Reattach to tmux session with: tmux attach -t <name>`) |
| keep, kill tmux | `tmux kill-session -t =<name>`, then keep | `Worktree kept at <path> on branch <branch>. Tmux session terminated.` |
| remove | kill the tmux session if any, then remove the worktree (`--force`) and delete its branch | `Worktree removed.` plus: `M commit(s) and uncommitted changes were discarded.` / `M commit(s) on <branch> was/were discarded.` / `Uncommitted changes were discarded.`; plus ` Tmux session terminated.` with tmux |
| Esc, with `onCancel` | `onCancel()` once. Nothing changes: the session, the cwd, the worktree and the cached tool results stay | none |
| Esc, without `onCancel` | the same as keep | as keep |

While working it shows `Keeping worktree…` or `Removing worktree…` with a
spinner. The outcome is passed as `onDone(message)`, a single argument.

After every keep or remove:
- the process directory and the session cwd are back at the session's original directory;
- the worktree session is cleared;
- the session's worktree state is recorded as none;
- every cached tool result is dropped (relative cache keys would now point at the wrong tree).

**With no worktree session**, the dialog draws nothing and calls
`onDone('No active worktree session found', { display: 'system' })`.

### 6. The cost notice

Inside `Dialog`:
- the headline is `You've spent $5 on the <label> this session.`;
- then `Learn more about how to monitor your spending:` and a hyperlink to `https://code.claude.com/docs/en/costs`;
- then a single answer, `1. Got it, thanks!`.

Enter, `1` and Esc each call `onDone()` once.

| Active provider | `<label>` |
|---|---|
| none configured, or Anthropic | `Anthropic API` |
| Bedrock | `AWS Bedrock` |
| Vertex | `Google Vertex` |
| Foundry | `Azure Foundry` |
| OpenAI-compatible | `OpenAI-compatible API` |
| Gemini | `Gemini API` |
| Mistral, GitHub Copilot, Codex, NVIDIA NIM, MiniMax | `API` |

## Edge cases and errors

- **Malformed project files** (`settings.json`, `settings.local.json`, `.mcp.json`) do not stop the trust question. The checks count a malformed file as nothing.
- **Trust inside a repository** is recorded for the repository root. Every directory below it is then trusted, and so is every directory below any trusted ancestor.
- **The worktree's original directory is gone:**
  - **remove**, asked or silent, reports `Worktree cleanup failed, exiting anyway`. The worktree and the session stay, and the cached tool results are dropped;
  - **keep** never finishes (finding 15).
- **No recorded start commit:** commits are counted as zero (finding 13).
- **The worktree was attached, not created by the session:** it is treated like any other (finding 12).
- **tmux is absent or the session is already gone:** the kill fails quietly, and the dialog goes on.

## Security requirements

1. Only "Yes, I trust this folder" (Enter on it, or `1`) records trust. Every other answer exits without writing.
2. Trust is written only to the user config file, keyed by the git root or folder. It is never written into the checkout.
3. Nothing inside the checkout can make `checkHasTrustDialogAccepted()` true.
4. In the home directory, trust lasts for the session only.
5. The trust checks name exactly the files that bring each thing (section 4). The rewrite must not narrow any of them.
6. The worktree exit dialog removes only after the user chose a remove answer, or when there is provably nothing to lose (findings 12 and 13 tighten "provably").

## Tests that pin it

- `src/permissions/ui/trust/TrustDialog.characterization.test.tsx` (23 tests):
  - the screen;
  - accept, in a plain folder and in the home directory;
  - already trusted, three ways;
  - five ways that must not count as trust;
  - in a child `bun test` with the real config file store: on-disk persistence (plain folder, git root, home directory), and every ending with its exit code.
- `src/permissions/ui/trust/utils.characterization.test.ts` (37 tests): a table of 34 folder layouts, each asking all seven checks, plus three runs with limited setting sources.
- `src/permissions/ui/WorktreeExitDialog.characterization.test.tsx` (22 tests). Each one builds a real repository with a real linked worktree, in the vcs worktree lab, with a recording `tmux` on `PATH`.
- `src/permissions/ui/CostThresholdDialog.characterization.test.tsx` (15 tests).
- `scripts/migrations/probes/rewrite-permissions-sessionDialogs.json` holds 40 probes over the four files. Every accept or keep path is also mutated to fail open (never ask, decline trusts, Esc trusts, Enter or Esc removes).

The suites mount through `permissions/ui/__testutils__/promptFrameRig.tsx` and
`terminal/__testutils__/fakeTerminal.ts`. The worktree suite uses
`vcs/git/__testutils__/worktreeLab.ts`. No file outside the unit pins the
dialogs' texts byte for byte.

## Out of scope

- **Dropped: the worktree dialog's texts for a question with nothing to lose.** That covers the subtitle `You are working in a worktree. Keep it to continue working there, or remove it to clean up.`, the remove description `Clean up the worktree directory.`, and the bare `Worktree removed.` message. The question is only shown when there are changes or commits, so none of them can appear. If finding 12 or 13 makes the question appear with nothing counted, the rewrite needs a subtitle for that case. These texts may be reused.
- **Whether startup shows the trust dialog at all** belongs to `showSetupScreens` (finding 6), as does what runs after trust.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **Security: the trust dialog names nothing the folder brings.** Its text is the same for an empty folder and for one with hooks, Bash allow rules, an `apiKeyHelper`, AWS/GCP credential commands, `otelHeadersHelper`, unsafe `env`, project MCP servers, and project commands or skills that allow Bash. The `commands` prop has no visible effect. The checks of section 4 exist, but nothing shows their answers. | **Fix** (not pinned). Under the generic warning, list each kind found with the file it comes from: the seven checks; the project `.mcp.json` servers (their names); and the project or local commands and skills whose allowed tools include `Bash`. Nothing can depend on the dialog saying less. The existing text, answers and endings stay as pinned. |
| 2 | **Security (routed: setup 1, modeDialogs 1): a checkout can choose a bypass start.** Its settings can set `permissions.defaultMode` to `bypassPermissions` or `auto`, and its `settings.local.json` can carry `skipDangerousModePermissionPrompt`. The trust dialog mentions neither. | **Interactive: fix**, as part of finding 1. The list names a repo-set `defaultMode` of `bypassPermissions` or `auto`, and a skip found in the folder's local file. **Headless (`-p`): keep for parity, track.** Headless never shows this dialog, and CI setups rely on a checked-in `defaultMode`. Running `-p` in a checkout is the user's opt-in, as it is for hooks. |
| 3 | **Security (routed: setup 2): a checkout can widen the working directories** with `permissions.additionalDirectories`. | **Fix** in the dialog: the list names the extra directories. The behaviour itself stays for parity in `permissions/filePaths`. |
| 4 | **Security (routed: mcp/core 3): a checkout can approve its own `.mcp.json` servers** with `enableAllProjectMcpServers` or `enabledMcpjsonServers`. This dialog is the only gate in front of that, and it says nothing. | **Fix** in the dialog: the server list (finding 1) says when the folder's own settings pre-approve the servers, so they will connect without the per-server question. The setting stays for parity. |
| 5 | **Security (routed: mcp/auth 1 and 2): `headersHelper`.** A project server's `headersHelper` is a command from the checkout. Under `-p` it runs without trust, and once a folder is trusted any helper a later pull adds runs too. | **Keep for parity, track** for both. `-p` skipping trust is relied on by scripted use, and per-server approval belongs to `mcp/config`. **Fix** in the dialog: a listed server is marked when it has a `headersHelper`. |
| 6 | **Security: the trust dialog is never shown for third-party providers.** `showSetupScreens` shows it only when the active provider uses the Anthropic account flow. It then raises the session trust latch for every provider. With an OpenAI-compatible, Gemini, Mistral, Copilot, Bedrock, Vertex or Foundry profile, a freshly cloned folder's hooks, `env`, helpers and project servers are therefore trusted with no question. | **Fix, routed** to the owner of `showSetupScreens` (`terminal/interactiveHelpers.tsx`): show the dialog for every provider, and raise the latch only after an answer. This unit's code is not involved. It is not pinned here, because the startup screens are skipped under `NODE_ENV=test`. |
| 7 | **Esc exits with code 1; `n` exits with code 0.** Both refuse. The bypass dialog maps Esc to 0. | **Keep for parity** (pinned). No trust is granted either way. |
| 8 | **Trusting is the focused answer,** so Enter alone trusts the folder. | **Keep for parity** (pinned). It is the established flow, and users press Enter through it; a changed default would be noticed. |
| 9 | **Trust is inherited downwards.** A subfolder records trust for the whole repository, and a trusted ancestor (say `~/src`) covers every checkout below it. | **Keep for parity** (pinned). Decided by `platform/config`; users rely on trusting a parent once. |
| 10 | **The security guide and cost links point at another product's documentation** (`code.claude.com`). | **Keep for parity** (pinned), track with the same links in `permissions/modeDialogs`. Which documents to link is a product-wide decision. |
| 11 | **The trust checks ignore `--setting-sources`.** They name the folder's files even when the session will not load them. | **Keep for parity** (pinned). It errs toward warning. |
| 12 | **The worktree exit dialog deletes a worktree the session only attached to.** A session can enter a pre-existing worktree, and the session is then marked as attached. If nothing changed since, `/exit` silently runs `git worktree remove --force` on it and `git branch -D` on its branch. Checked with a real repository. The model's exit tool refuses to remove an attached worktree. | **Fix** (not pinned). For an attached worktree, never remove: return to the original directory and report it kept. No workflow can rely on losing a worktree the session did not create. |
| 13 | **An unknown start commit counts as zero commits.** A session with no recorded start commit (hook-made worktrees, some resumed sessions) and a clean tree is removed silently, commits and branch included. Checked: two commits were discarded. | **Fix** (not pinned). When the start commit is unknown, ask, and say the commits could not be counted. |
| 14 | **The caller hears "No active worktree session found" around the real outcome.** Once the dialog has ended the session, every redraw reports that message as a system message, sometimes before the outcome (after keep: twice before, once after). `ExitFlow` acts on the first call, so the user can see that message instead of "Worktree kept …". | **Fix** (not pinned; the suites filter it out). Report the outcome exactly once, and report the no-session message only when there was no session at mount. |
| 15 | **Keep never finishes when the original directory is gone.** The move back fails as an unhandled rejection, and the dialog stays on `Keeping worktree…` for good; `/exit` hangs. | **Fix** (not pinned). Report `Worktree cleanup failed, exiting anyway`, as remove does, and finish. |
| 16 | **A failed removal leaves the worktree and the session in place,** and reports `Worktree cleanup failed, exiting anyway`. | **Keep for parity** (pinned). It fails safe. |
| 17 | **The cost notice names five providers just `API`,** and the amount in the headline is fixed text. | **Keep for parity** (pinned). The threshold is decided by the REPL. |

## Target design

- **Split the trust question from its evidence.**
  - A pure `describeWorkspace(folder)` returns a typed list of what the folder brings: each kind (hooks, Bash rules, helpers, credential commands, unsafe env, project servers with pre-approval and `headersHelper`, commands or skills allowing Bash, a repo-set start mode, the bypass skip, extra directories), with its source file.
  - The seven existing exports stay as thin views over it until `TrustDialog` is their only caller and goes away with them.
  - The dialog renders the list (finding 1) and owns only the answer. It records trust through one function that chooses between the session latch and the project entry.
- **Endings as data.** One table maps each answer to accept, or to exit with a code, so the exit codes of finding 7 cannot drift.
- **Worktree exit as a state machine with one exit.** Its states are loading, asking, working and finished. The outcome is computed by a pure function of (session, uncommitted count, commit count or unknown, answer), and `onDone` is called exactly once, from the finished state. The same function covers attached worktrees and the unknown commit count (findings 12–15).
- **Cost notice.** It takes the provider label from one map keyed by `APIProvider`, shared with any other place that names a provider to the user.
