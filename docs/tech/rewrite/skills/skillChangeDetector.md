# Spec: `skills/skillChangeDetector`

## Purpose

Hot reload for skills and legacy commands. The detector watches the
directories that skills and `/commands` markdown files load from. When files
there change, it gives the ConfigChange hooks a chance to veto the reload,
drops the caches that hold the skill and command listings, and tells its
subscribers, which then re-read the command list:

- the REPL, through `useSkillsChange` (`src/platform/useSkillsChange.ts`);
- headless streaming, through `runHeadlessStreaming`
  (`src/platform/headless/print/runHeadlessStreaming.ts`).

It also relays the skills that `src/skills/loadSkillsDir.ts` discovers
mid-session, so the same subscribers hear about those too.

`startDeferredPrefetches()` (`src/platform/main/deferredPrefetches.ts`) starts
the detector after the first render in the REPL, and in headless mode. Nothing
starts it in bare mode (`--bare`, `CLAUDIN_SIMPLE`).

## Public contract

Callers use one exported object, and its members keep their names and
signatures.

| Export | Signature | Used by |
|---|---|---|
| `skillChangeDetector.initialize` | `() => Promise<void>` | `src/platform/main/deferredPrefetches.ts`, which does not await it |
| `skillChangeDetector.subscribe` | `(listener: () => void) => () => void`, returning the unsubscribe function | `src/platform/useSkillsChange.ts`, `src/platform/headless/print/runHeadlessStreaming.ts` |
| `skillChangeDetector.dispose` | `() => Promise<void>` | the graceful-shutdown cleanup the detector registers for itself; tests |
| `skillChangeDetector.resetForTesting` | `(overrides?: { stabilityThreshold?: number; pollInterval?: number; reloadDebounce?: number; chokidarInterval?: number }) => Promise<void>` | tests only |

The module also has `initialize`, `dispose`, `subscribe` and `resetForTesting`
as named exports, identical to the object's members. Nothing imports them, and
`knip-baseline.json` lists all four as unused, so the rewrite exports the
object alone.

Each override is in milliseconds and replaces one default:

| Key | What it sets | Default |
|---|---|---|
| `stabilityThreshold` | how long a file must keep its size before its change counts | 1000 |
| `pollInterval` | how often that is checked | 500 |
| `reloadDebounce` | the quiet period before a reload | 300 |
| `chokidarInterval` | how often the file system is polled, when it is polled (see Platform notes) | 2000 |

An absent key keeps its default. `chokidarInterval` names a library, but the
key stays because the suite passes it.

## Observable behaviour

### 1. Where it looks

`initialize()` works out these locations once, and watches the ones that exist
at that moment:

| Location | Path |
|---|---|
| user skills | `<config home>/skills`, where the config home is `getClaudinConfigHomeDir()`: `CLAUDIN_CONFIG_DIR`, or `~/.claudin` |
| user commands | `<config home>/commands` |
| project skills | `.claudin/skills`, resolved against the process working directory |
| project commands | `.claudin/commands`, resolved the same way |
| additional directories | `<dir>/.claudin/skills` for every `<dir>` in `getAdditionalDirectoriesForClaudeMd()` (the `--add-dir` list). This is skills only: the `.claudin/commands` of an additional directory is not watched. |

The first four are what `getSkillsPath()` in `src/skills/loadSkillsDir.ts`
returns for `userSettings` and `projectSettings`.

- **Created later.** A location that does not exist when `initialize()` runs
  is not watched for the rest of the process, even once it is created. Calling
  `initialize()` again does not add it.
- **Nothing else is watched.** That includes the config home itself
  (`settings.json`, `agents/`), the project root, and `.claudin/` itself.
- **No location at all.** When none exists, `initialize()` still resolves.
  Nothing on disk is ever reported, but discovery loads (section 5) are still
  relayed.

### 2. What counts as a change

A change is a regular file being **created**, **modified** or **deleted** at
most two directories below a watched location: `<location>/<file>`,
`<location>/<a>/<file>` or `<location>/<a>/<b>/<file>`.

- **Modifications.** An edit counts even when the size stays the same. A new
  modification time is enough.
- **Directories.** A new skill directory counts through the `SKILL.md` inside
  it. Deleting a directory counts through the files it held.
- **File names.** Every file counts, whatever its name or extension. A `.txt`
  next to the skills counts as much as a `SKILL.md`.

These are not changes:

- a file three or more directories down (`<location>/<a>/<b>/<c>/<file>`);
- a directory on its own, so creating or removing an empty directory reports
  nothing;
- anything whose path has a `.git` segment. That covers a `.git` directory and
  everything in it, and a `.git` file such as a submodule's gitfile. A name
  that only starts with `.git`, like `.gitignore` or `.github/`, is a change
  like any other;
- editor temporaries: a name ending in `~`, dot-prefixed vim swap files
  (`.SKILL.md.swp`, `.SKILL.md.swx`), and Sublime's `.subl….tmp`;
- special files: FIFOs, sockets and devices;
- the files already in place when watching starts. They are watched from then
  on, and an edit to one is a change, but their presence is not reported.

A subdirectory the process cannot read is skipped, with no error.

### 3. Batching and timing

- **Stability.** A created or modified file counts only once its size has
  stayed the same for the stability threshold: one second by default, checked
  every half second. A file that keeps growing is not reported until it stops,
  so in practice a change counts 1 to 1.5 s after the last write. Deletions do
  not wait for this.
- **Quiet period.** Changes are gathered into a batch. The batch reloads once
  no further change has counted for the quiet period (300 ms by default), and
  each new change restarts that period. A slow trickle of changes is therefore
  still one reload.
- **End to end.** With the defaults, a write is reported about 1.3 to 3.8 s
  later under Bun, which polls every 2 s, and about 1.3 to 1.8 s later under
  Node.

### 4. What a reload does

A reload does four things, in this order:

1. **It runs the ConfigChange hooks, once for the batch.** It calls
   `executeConfigChangeHooks('skills', <path>)` from
   `src/platform/lifecycleHooks/`.
   - The hook input has `hook_event_name: 'ConfigChange'` and `source: 'skills'`.
   - `file_path` is the absolute path of one changed file in the batch. Today
     that is the first change that counted.
   - Hooks match on the query `skills`.
2. **A blocking hook cancels the reload.** If any result blocks
   (`hasBlockingResult`), nothing else happens: no cache is dropped and no
   subscriber is told.
   - The batch is discarded, not retried.
   - The next change reloads everything, including the files the hook vetoed.
3. **It drops the caches**, so the next read goes back to disk:
   - `getSkillDirCommands(cwd)` and the markdown-command loader re-read their
     directories (`clearSkillCaches()`).
   - `getCommands(cwd)`, `getSkillToolCommands(cwd)` and
     `getSlashCommandToolSkills(cwd)` recompute, and the plugin command and
     skill caches reload (`clearCommandsCache()`, which also calls
     `clearSkillCaches()`).
   - The record of skills already announced to the model is emptied, and so
     is the one-shot suppression of the next listing (`resetSentSkillNames()`
     in `src/agent/attachments/`). The next turn lists the skills again.
4. **It tells the subscribers.** This comes after the caches are dropped, so a
   subscriber that reads a listing gets fresh data. Each subscriber is called
   once per reload, with no arguments.

### 5. Skills discovered during the session

`src/skills/loadSkillsDir.ts` announces the skills it finds mid-session through
`onDynamicSkillsLoaded`. Those are the skills from `addSkillDirectories`, and
conditional skills that `activateConditionalSkillsForPaths` switches on.

Once `initialize()` has run in the process, every such load does the following
before its promise resolves:

- **It drops the memoized command lists** (`clearCommandMemoizationCaches()`),
  so `getSkillToolCommands` and `getSlashCommandToolSkills` include the new
  skills.
- **It tells every subscriber**, once, with no arguments.

It does not do the rest of a reload:

- `getSkillDirCommands` keeps its memoized result.
- No hook runs, and there is no quiet period.
- The record of announced skills is kept.

The link to `onDynamicSkillsLoaded` is made once per process, by the first
`initialize()`. After that it stays, through `dispose()` and
`resetForTesting()` alike. Before any `initialize()`, discovery loads reach no
subscriber.

### 6. Lifecycle

- **`initialize()`**
  - It resolves once watching is set up. The first scan of the locations
    finishes shortly after, so a change made in the first few milliseconds can
    be missed.
  - It is idempotent. A second call, whether concurrent or later, does
    nothing, so there is only ever one watcher.
  - After `dispose()` it does nothing until `resetForTesting()`. That holds
    even when `dispose()` came before the first `initialize()`.
  - It registers a cleanup with `registerCleanup()`
    (`src/shared/cleanupRegistry.ts`), which disposes the detector at
    graceful shutdown.
  - The watcher never keeps the process alive: a process with nothing pending
    but the watcher exits.
- **`subscribe(listener)`** returns a function that removes the listener.
  Subscribing before `initialize()` works.
- **`dispose()`**
  - It closes the watcher, cancels a batch still waiting out its quiet period,
    drops every subscriber, and unregisters its shutdown cleanup.
  - It resolves once the watcher is closed.
  - Calling it again, or before `initialize()`, is safe.
- **`resetForTesting(overrides?)`**
  - It closes a running watcher, cancels a waiting batch, and drops every
    subscriber.
  - It re-arms `initialize()`, after `dispose()` too.
  - It sets the timing overrides. Called without any, it clears them.

## Edge cases and errors

| Case | What the caller sees | Pinned |
|---|---|---|
| No watched location exists at `initialize()` | It resolves, and nothing on disk is ever reported for the life of the process. | yes |
| A location is created after `initialize()` | Not watched, even after a second `initialize()`. | yes |
| A ConfigChange hook blocks | No reload and no notification. The batch is not retried. | yes |
| An interactive session without workspace trust | The hooks layer skips the hooks, and the reload goes ahead. | no |
| `dispose()` while a reload's hooks are already running | That reload still completes: it drops the caches and tells anyone who subscribed after `dispose()`. | no |
| `dispose()` while `initialize()` is still working out the locations | A watcher is created anyway. It keeps reporting and registers a shutdown cleanup. | no: a gap, see Target design |
| A listener subscribed after `dispose()` | It still hears discovery loads, though not changes on disk. | no |
| The same listener subscribed twice | It is called once per event, and one unsubscribe removes it. | no |
| A subscriber throws during a reload | The subscribers after it are skipped, and the error escapes as an unhandled promise rejection. | no: see Target design |
| A subscriber throws during a discovery load | The subscribers after it are skipped. `onDynamicSkillsLoaded` logs the error, and the load itself succeeds. | no |
| A subdirectory is unreadable | It is skipped, with no error. | no |

## Platform notes

- **Bun polls, Node listens.** Under Bun the file system is polled with
  `stat()`, every 2 s by default, instead of using native change events. The
  reason is a deadlock in Bun's native watcher (oven-sh/bun#27469, #26385):
  closing a watcher while its thread is still delivering events can hang both
  threads, and a watcher over a large skill tree during a git operation
  triggers it.
  - The shipped CLI runs `dist/cli.mjs` under Node (`bin/claudin`), with native
    events.
  - Everything run by Bun polls, the test suite included.
  - Drop the workaround once Bun ships the fix.
- **Polling cost.** Every watched file and directory is statted once per
  interval. The 2 s default keeps that cheap on a large skill tree.
- **Only polling is tested.** `bun test` runs under Bun, so the suite never
  exercises native events.
- **Windows.** The `.git` rule splits paths on the platform's separator, so it
  holds on Windows. The special-file test is skipped there, since Windows has
  no `mkfifo`.

## Tests that pin it

- `src/skills/skillChangeDetector.characterization.test.ts` has 24 tests, one
  of them skipped on Windows, and covers 98.2% of the old module's lines. It
  takes about 42 s, because it waits on real file-system polling.
- `scripts/migrations/probes/rewrite-skillChangeDetector.json` has 25 probes,
  and every test is the target of at least one.
- No other test imports the module.

The suite observes the module from outside, and the rewrite has to keep these
working:

- **Temp locations.** It points the config home (`CLAUDIN_CONFIG_DIR`), the
  process working directory and the additional-directory list at a temp root,
  per test.
- **A hook.** It registers a ConfigChange callback hook with
  `registerHookCallbacks`, matcher `skills`. It also marks the session
  non-interactive, so the hook runs without a trust check.
- **Cache reads.** It reads the caches through `getSkillDirCommands`,
  `getCommands`, `getSkillToolCommands` and `_getSkillLatchSnapshotForTests`,
  and triggers discovery loads with `addSkillDirectories`.
- **A child process.** One test runs the detector in a `bun` child with
  `src/stubs/test-preload.ts` preloaded. That is how it sees the process exit
  and runs the graceful-shutdown cleanups (`runCleanupFunctions`).

**Not pinned, and why:**

- **Polling timings.** The 2 s polling default and the `pollInterval` and
  `chokidarInterval` overrides are not pinned. Where a poll falls relative to a
  write is random, so no bound on them holds reliably in a test.
- **Native-event mode**, because the suite runs under Bun.
- **Deletions skip the stability wait.** They do, but nothing depends on it.
- **The edge cases marked "no"** in the table above.

## Out of scope

Nothing is dropped except the unused named exports (see Public contract).

## Outcome (2026-09-28)

**The implementation.** `skillChangeDetector.ts` is now a 54-line facade that
wires seven modules in `src/skills/changeDetection/`: watched locations,
ignored paths, the file watcher with the Bun polling check, the change batch,
the reload, the subscribers and the lifecycle. It was written in a sandbox that
had no history, no old module and no fingerprints.
- **Characterization suite:** passes unchanged, three runs in a row.
- **New unit tests:** 11, in three files.
- **Probe spec:** re-authored against the new code with 39 probes, and every one turns the suites red.
- **Provenance:** every new file measures zero inherited lines.

**The two fixes the Target design asked for:**
- **A `dispose()` that arrives during `initialize()`.** `dispose()` and `resetForTesting()` advance a generation, and `initialize()` checks it again after it has worked out the locations. A stale start creates no watcher and registers no cleanup.
- **Isolated subscribers.** Each subscriber is wrapped once. A throw or a rejected promise is logged with `logError`, and the remaining subscribers still run, on the reload path and the discovery path alike.

**Other deliberate differences.** None of them was pinned before.
- **`resetForTesting`** also unregisters the shutdown cleanup.
- **Editor temporaries** are ignored by an explicit rule of this module, instead of by chokidar's internal filtering.
- **Special files** are only FIFOs, sockets and devices, so symlinks are still watched.

## Target design

- **The export.** Keep the one exported object with its four members, and
  export the overrides type by name.
- **Split the responsibilities** so each part can be tested without a watcher:
  - working out the locations: a pure function of the config home, the
    working directory, the additional directories and an existence check;
  - what is ignored (`.git` segments, files that are not regular): a pure
    predicate;
  - the batch: a quiet period that restarts on each change, and that
    `dispose()` and `resetForTesting()` can cancel;
  - the reload (hooks, then invalidation, then notification), which takes its
    collaborators as a narrow `…Deps` parameter
    (`.claudin/rules/code-design.md`);
  - the lifecycle: idle, watching, disposed.
- **Close the start-up gap.** Re-check for disposal after every `await` in
  `initialize()`, so that a `dispose()` arriving while the locations are being
  worked out stops the watcher from starting.
- **Isolate the subscribers.** Call each one in its own `try`/`catch` and log
  failures with `logError`. Then one broken subscriber can neither starve the
  others nor escape as an unhandled rejection. This is a deliberate difference
  from the old module, and the Outcome section should record it.
- **Subscriptions.** `createSignal()` (`src/shared/signal.ts`) already gives
  set semantics and an unsubscribe function.
- **The Bun workaround** stays a named, documented platform check that points
  at the Bun issues, so that it can be removed.
- **Types.** Explicit throughout, and no `any`.
