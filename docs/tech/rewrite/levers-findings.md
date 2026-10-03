# What the levers' cover round found

Collected on 2026-10-02 from the eleven cover units in
`scripts/migrations/rewrite/units/levers.json`, and from the three opencode ports.
Each defect is pinned by a characterization test in its current behaviour,
under a test name that says so. None is fixed here, except where a port's
brief marked it "fix". Fixing one means changing its pin in the same commit.

## Defects, pinned and not fixed

**Security-relevant**
- **`/config` copies project allow rules into user scope.** Changing "Default
  permission mode" writes the merged `permissions` into the user
  `settings.json`, so an `allow` rule from a project's `.claudin/settings.json`
  then applies in every project. Pinned in `Config.characterization.test.tsx`.

**Sessions**
- **`--resume <session-id>` drops replies that share a timestamp.** When several
  messages share the latest timestamp, `findLatestMessage`
  (`sessions/resume/chain.ts`) keeps the first. The resume then loads that
  message plus a synthetic "No response requested.", while resuming by title
  or `--continue` keeps them all. The headless suite met the same behaviour
  through `sessions/indexing/liteMetadata.ts`.

**Prompt and REPL**
- **Bash mode.** After typing `!` into an empty prompt, the cursor sits at 1, so
  Backspace and Escape no longer leave bash mode.
- **Footer pills.** With a footer pill selected and an empty prompt, ← opens
  `/resume` instead of stepping back through the pills.
- **Undo.** Ctrl+_ skips the text from just before the latest edit. The cause
  is in `useInputBuffer`.
- **Transcript.** In fullscreen, `q` does not close the transcript: the REPL's
  own key handler takes it before the `transcript:exit` binding sees it. Esc
  works.

**Agents and tasks**
- **The refusal names a rule nobody wrote.** An agent type left out by an
  `Agent(x, y)` allowlist is refused as "denied by permission rule
  'Agent(Code)' from settings".
- **Shell task cleanup.** `spawnShellTask` clears `unregisterCleanup` on
  completion without calling it; the other completion paths call it.
- **Task output dir.** `getTaskOutputDir()` reads `CLAUDIN_TMPDIR` at its first
  call and keeps it for the whole process.
- **Workflow picker.** In `WorkflowMultiselectDialog`, Esc does not cancel; it
  shows "You must select at least one workflow". The dialog joins the cut.

**LSP** (in `LSPServerInstance.ts` and `LSPServerManager.ts`, outside the port)
- A server that exits with code 0 by itself stays `running` but unhealthy, and
  is never restarted.
- After a crash, the record of open files survives the restart, so the new
  process never gets `didOpen`.
- Every `didChange` is sent as version 1.
- A server that stays alive but never answers `shutdown` makes `stop()` wait
  forever. Nothing covers this case.

## Fixed by the ports

- **Codex OAuth:** only a listen error with code `EADDRINUSE` reads as a busy
  callback port. Before, any error whose text held the port number did.
- **LSP client:**
  - an `initialize` the server dies under now rejects;
  - a refused `shutdown` no longer blocks a restart;
  - an unreadable message is dropped instead of breaking the client.
- **MCP OAuth:**
  - the callback server answers stray paths like `/favicon.ico` with 404 instead of hanging;
  - invalidating the PKCE verifier works when the server has no stored entry.

## Open decisions

- **`clientMetadataUrl`.** The MCP OAuth provider defaults it to
  `https://claude.ai/oauth/claude-code-client-metadata`. On an authorization
  server that supports client-ID metadata documents, Claudin therefore
  presents Claude Code's client id. The value is kept, in one constant
  (`CLIENT_ID_METADATA_DOCUMENT_URL`), until this is decided.
- **The Bash permission prefix has no pin for one-word commands.** For
  `rm build`, the dialog offers `rm build:*`, and no test checks it. A change
  that widened it to `rm:*` passed every suite. Pin it before phase 6 rewrites
  `prefixes.ts`.

## Coverage exceptions

Two surviving files the cut touches stay below target:
- **`entrypoints/cli.tsx` (18%).** Past its fast paths it either starts the whole
  CLI or calls `process.exit` inside `void main()`, so a test process cannot
  drive it further without a seam in production code.
- **`toolPermission/handlers/interactiveHandler.ts` (46%, about 59% after the cut).**
  About 100 of its lines sit behind `BASH_CLASSIFIER` and
  `TRANSCRIPT_CLASSIFIER`. Those flags are true in the build and false under
  `bun test`.

The cut edits neither file's covered behaviour, so the cut goes ahead.
Covering these lines is a task of its own: a test round with the build's flags
on (`bun test --feature=NAME`), and a seam in `cli.tsx`.

## Test hazards

- **A test reached the real API.** `handleSideQuestion` forks a real model
  request whenever `forkedAgent`'s `lastCacheSafeParams` is set. In a full
  run an earlier file left one behind, and a characterization test reached
  `api.anthropic.com` (401). Clear it with `saveCacheSafeParams(null)` before
  driving `side_question` or `generate_session_title`.
- **A test launched a real editor.** `getExternalEditor` is memoized and falls
  back to `code`, `vi` or `nano` on PATH. A REPL test with `VISUAL` and
  `EDITOR` unset launched one. Stub `VISUAL`, and clear the cache before and after.
- **Leaks between files.** The full run had 79 failures that no single file
  showed. `.claudin/rules/testing.md` now records the cause of each:
  - `mock.module` stubs that were never restored, or restored from a live namespace;
  - `process.env` reassigned instead of restored in place;
  - keys deleted from the shared test global config.
