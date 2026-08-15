# Self-hosted background agent (R3)

Claudin can run an agent **workflow** unattended from a trigger — the
"trigger → isolated run → PR + report" loop that vendor clouds offer, but
**self-hosted and privacy-first**: it polls outbound only (no inbound webhook
server, no open port) and everything runs on your own machine or runner, under
your own credentials.

It is a thin ingress layer on top of the existing
[`/workflows`](../../../src/tools/AgentWorkflow) engine — the run itself is the
same `runWorkflow` state machine, just driven by code instead of the REPL.

- **`workflow run`** — the primitive: run one workflow to completion headlessly,
  optionally in an isolated worktree, optionally opening a PR.
- **`workflow watch`** — the loop: poll a **trigger source** and dispatch one
  `workflow run` per new item, forever.

Both live under the `workflow` command group, gated by the `AGENT_WORKFLOWS`
build flag (on in open builds).

## How it fits together

```
                 ┌────────────────────── workflow watch ───────────────────────┐
                 │  every --interval:                                           │
   trigger  ───▶ │   source.poll() ─▶ [--match filter] ─▶ dedup by id ─▶ spawn ─┼─┐
   (issue/URL/   │                                         (watch-state.json)   │ │
    command)     │   reportResult?  ◀────────────── PR: <url> ◀─────────────────┼─┘
                 └──────────────────────────────────────────────────────────────┘
                                                                │ subprocess (clean process)
                                                                ▼
                        ┌──────────────── workflow run ─────────────────┐
                        │  git worktree ─▶ runWorkflow(engine) ─▶ report │
                        │                        │                       │
                        │                        ▼   on `done` + --pr    │
                        │            commit ─▶ push ─▶ gh pr create       │
                        └────────────────────────────────────────────────┘
```

The watcher and each run are **separate OS processes**: the watcher never loads
the model or touches a worktree itself, so a crashing run can't take the loop
down, and each run gets a clean process + isolated checkout.

## `claudin workflow run <name> --task "<text>"`

Runs one workflow to completion headlessly and (optionally) opens a PR.

| Flag | Default | Meaning |
|------|---------|---------|
| `--task <text>` | *(required)* | Task/goal that seeds the workflow |
| `--worktree` | off | Run inside an isolated git worktree (`.claudin/worktrees/wf-<name>-<id>` on branch `worktree-<slug>`). Off = runs in the current checkout. |
| `--pr` | off | On a successful (`done`) run: commit changes, push the branch, and open a PR via `gh` |
| `--base <branch>` | remote default | PR base branch |
| `--report <file>` | temp file | Where to write the markdown run report (`exportRunSummary`) |

**Exit code** (deterministic — this is what the watcher and CI key off):

| Code | Meaning |
|------|---------|
| `0` | Run reached `done` (terminal success) |
| `1` | Run finished but not `done` (`stalled`/`failed`/`cancelled`), or it threw |
| `2` | Unknown/invalid workflow, or worktree creation failed |

On success it prints `workflow <runId> <status>` on stdout, and with `--pr` a
single `PR: <url>` line.

**Permissions.** The run uses a `bypassPermissions` session — a background agent
can't answer a permission prompt. Individual workers still clamp down to their
own agent definition's permission mode (the engine's `clampMode`), so a worker
declared read-only stays read-only.

**`--pr` without `--worktree`.** Supported, but on your live branch the runner
will **not** `git add -A` your working tree; it pushes only what's already
committed and warns about uncommitted changes. Use `--worktree` (the watcher
always does) if you want the run's own changes committed and PR'd automatically.

## `claudin workflow watch --workflow <name>`

The "listening" loop: every `--interval` seconds it polls a **trigger source**,
applies the optional `--match` filter, dispatches one
`workflow run … --worktree --pr` subprocess per **new** item (serially),
captures the child's `PR: <url>` line, and — when the source supports it —
reports the result back.

| Flag | Default | Meaning |
|------|---------|---------|
| `--workflow <name>` | *(required)* | Workflow to run for each trigger |
| `--source <source>` | `github` | Trigger source: `github`, `url`, or `command` |
| `--label <label>` | `claudin` | (github) Issue label that triggers a run |
| `--url <url>` | — | (url) Link/endpoint to poll; required for `--source url` |
| `--command <cmd>` | — | (command) Local shell command to poll; required for `--source command` |
| `--match <regex>` | — | Only trigger on items whose title/body matches this regex |
| `--interval <seconds>` | `30` | Poll interval (floored at 5s) |
| `--base <branch>` | remote default | PR base branch passed to each run |

Each job runs in its **own worktree** so the watcher never touches your live
working tree while you keep working in the same repo. Jobs are processed
**serially** in v1 (no worktree contention). Stop with Ctrl-C (it finishes the
current sleep, then exits cleanly).

### Trigger sources

All three sources share the same body-parsing:

- **JSON feed** — if the body is a JSON array (or a `{"tasks":[…]}` /
  `{"items":[…]}` wrapper), each element is one task. A string element is the
  task text; an object element uses `title`/`body` (fallbacks: `task`,
  `description`, `name`). Deduped by the element's `id`/`number` when present,
  otherwise by a content hash.
- **Content-change** — anything else (HTML/plain text) becomes a single trigger
  keyed by a hash of the body, so a run fires **only when the output actually
  changes**.

| Source | Polls | Dedup id | Reports back |
|--------|-------|----------|--------------|
| `github` | `gh issue list --label <label> --state open` | `gh#<number>` | comments the PR URL on the issue |
| `url` | HTTP `GET <url>` | `url#<id>` / `url:<hash>` | — |
| `command` | your `<cmd>`, reads **stdout** | `cmd#<id>` / `cmd:<hash>` | — |

The id prefix is per-source, so switching sources against the same state file
can't cross-trigger.

- **`github`** turns each new labeled issue into a run and posts the resulting
  PR URL back as an issue comment. Needs an authenticated `gh`.
- **`url`** bridges any HTTP-reachable signal — a status page, a JSON queue
  endpoint, a gist. 20s request timeout; non-2xx or a network error fails soft
  to no triggers.
- **`command`** bridges any **local** signal — a script that checks a queue, a
  file, a database, a CI status, and prints work to stdout. A non-zero exit (or
  spawn failure) fails soft to no triggers.
  > ⚠️ The command runs through the shell with your own privileges. You opt in
  > explicitly via `--command`, and it only ever runs on your machine — but
  > point it only at commands you trust, exactly as you would a cron entry.

### Filtering with `--match`

`--match <regex>` gates every source: an item is dispatched only if the regex
matches its title-plus-body (joined by a newline, so it hits either). This
avoids running on irrelevant changes — e.g. a status page that changes on every
poll, but you only care when it says `READY`.

```bash
# Only fire when the command's output contains a READY: line
claudin workflow watch --workflow ship --source command \
  --command './scripts/queue.sh' --match '^READY:'
```

The pattern is a standard JavaScript `RegExp` (case-sensitive; write
`[Rr]eady` or a character class if you need case-insensitivity). An invalid
regex exits `2` at startup. Filtered items are **not** marked processed, so if
the content later changes to match, it can still fire.

## State & dedup

Processed trigger ids are persisted per repo to
`.claudin/workflow-watch-state.json` (git-ignored by the blanket `.claudin/`
ignore), so a restart never re-runs past triggers. Writes are **atomic**
(temp-file + rename) so a crash mid-write can't corrupt the file — a corrupt
read would fail open to an empty set and re-dispatch everything (duplicate PRs).
Items are marked processed regardless of run outcome, so a persistently-failing
trigger isn't retried forever.

## Prerequisites

- The [`gh` CLI](https://cli.github.com) installed and authenticated
  (`gh auth status`) — used for issue polling (github source), PR creation, and
  comments. Not needed for `url`/`command` sources unless you use `--pr`.
- A configured provider/model (`/provider`) — the workflow agents call the model.
- At least one workflow definition in `.claudin/workflows/<name>.md`
  (see the [/workflows docs](../../../src/tools/AgentWorkflow)).

## Examples

```bash
# One-off, isolated, open a PR:
claudin workflow run dev-flow \
  --task "Add a --json flag to the status command" --worktree --pr

# Listen on GitHub: every issue labeled `claudin` becomes a PR:
claudin workflow watch --workflow dev-flow --label claudin --interval 30

# Poll a JSON task queue over HTTP (one run per array element):
claudin workflow watch --workflow dev-flow \
  --source url --url https://example.com/queue.json

# Trigger from a local command, only when its output signals READY:
claudin workflow watch --workflow dev-flow \
  --source command --command './scripts/next-task.sh' --match '^READY:'
```

## Scope (v1)

**In:** local polling watcher; `github` / `url` / `command` sources; `--match`
filter; worktree isolation per job; PR-out + issue-comment report-back;
deterministic exit code from run status; atomic dedup state.

**Out (deliberately):** inbound webhook server; parallel/multi-tenant jobs;
sandbox enforcement (tracked separately as R2); non-GitHub forges (GitLab/Gitea)
with report-back; a committed GitHub Action template.

## Where the code lives

- `src/platform/main/commands/workflow.ts` — the `workflow run|watch` subcommands
  (registered in `src/platform/main/registerSubcommands.ts`).
- `src/platform/headless/workflow/runWorkflowHeadless.ts` — builds a headless
  `ToolUseContext` (mirroring `src/platform/entrypoints/mcp.ts`) and calls `runWorkflow`
  directly; owns the worktree lifecycle + report + PR + exit code.
- `src/platform/headless/workflow/sources.ts` — the `TriggerSource` abstraction and its
  `github` / `url` / `command` implementations (incl. the pure `parseFeed`).
- `src/platform/headless/workflow/githubSource.ts` — `gh`/git glue (list issues, push, PR,
  comment) with pure parse helpers.
- `src/platform/headless/workflow/watchLoop.ts` — the source-agnostic poll loop, `--match`
  filter (`compileMatcher`/`itemMatches`), and the run-subprocess dispatcher.
- `src/platform/headless/workflow/watchState.ts` — the atomic processed-id dedup store.
