# Project-Local, Git-Tracked Team Memory

**Status:** Default ON for git projects. Set `autoMemoryProjectLocal: false`
in settings.json (user/local/policy — never projectSettings, for security)
to force the legacy global-only location.
**Scope:** `src/memory/memdir/paths.ts`, `src/memory/memdir/memoryMigration.ts`,
`src/memory/memdir/teamMemPaths.ts`, `src/memory/memdir/teamMemPrompts.ts`,
`src/memory/memdir/memoryTypes.ts` (the team categories),
`src/memory/memdir/pathScopedMemories.ts` (on-demand loading),
`src/memory/autoDream/dreamDigest.ts` (what the dream reads),
`src/commands/memory/sortPrompt.ts` (`/memory sort`).

## Problem

Claudin's auto-memory (private notes + the `team/` subfolder) used to live
entirely outside the repo, under
`~/.claudin/projects/<sanitized-git-root>/memory/`. "Team" memory was meant
to reach collaborators via a server-mediated sync that required first-party
Anthropic OAuth *and* a `github.com` remote. Claudin is explicitly
provider-agnostic and not Anthropic-account-bound, so that sync path never
activated for most Claudin users — including any project hosted on a
self-hosted git server (Gitea, GitLab CE, Bitbucket Server, etc.). Team
memory ended up stuck local-only for everyone who isn't both on Anthropic
OAuth and GitHub.

The sync code was **deleted on 2026-09-21**. Git is the sync: the team dir is
tracked, a file written there shows up in `git status`, and it reaches
teammates through ordinary commits. `scripts/verify/verify-no-phone-home.ts`
bans the old endpoint (`api/claude_code/team_memory`) so it cannot come back.

## Fix

`getAutoMemPath()` (`src/memory/memdir/paths.ts`) now defaults to
`<gitRoot>/.claudin/memory/` for any project inside a git repository — the
same project-local pattern already used for `.claudin/plans/`
(`src/agent/plans/plans.ts`), with the same symlink-escape containment check and
fallback to the legacy global path if verification fails or the project
isn't a git repo. `getTeamMemPath()` derives from `getAutoMemPath()`, so the
`team/` subfolder moves along with it automatically.

Resolution order (first match wins):

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (Cowork only)
2. `autoMemoryDirectory` in settings.json (trusted sources only)
3. `<gitRoot>/.claudin/memory/` when `autoMemoryProjectLocal` isn't `false`
   and the realpath-verified containment check passes
4. `<memoryBase>/projects/<sanitized-git-root>/memory/` (legacy global path)
   — used for non-git projects and whenever step 3 can't be verified safe

### Migration

The first time the project-local path resolves for a project whose legacy
global directory already has memory content, `migrateGlobalMemoryIfNeeded()`
(`src/memory/memdir/memoryMigration.ts`) **copies** that content into the new
location — it never deletes or moves the original, so the old
`~/.claudin/projects/.../memory/` directory remains as a backup. The copy is
idempotent: once the project-local directory has any memory content of its
own, migration is skipped.

### Making `team/` actually git-trackable

Most projects' `.gitignore` blanket-excludes `.claudin/` (Claudin scaffolds
this by default), which would silently swallow `.claudin/memory/team/` even
after it becomes project-local. Claudin never edits `.gitignore` in code —
instead, when `buildCombinedMemoryPrompt()` detects this conflict
(`isTeamMemLikelyGitIgnored()` in `src/memory/memdir/teamMemPaths.ts`, a best-effort
heuristic that only recognizes the common blanket-ignore pattern shape), it
adds a guidance paragraph to the memory system prompt asking the model to
show the user this diff and apply it only with explicit approval:

```gitignore
/.claudin/*
!/.claudin/memory/
/.claudin/memory/*
!/.claudin/memory/team/
```

This carves out `memory/team/` (git-tracked, reaches teammates via ordinary
`git push`/`pull`/`clone`) while everything else under `.claudin/` — private
`memory/*.md`, `plans/`, `settings.local.json`, `rules/`, `skills/`,
`agents/` — stays ignored, exactly as before.

### Secrets

Every Edit/Write/apply_patch/staged write into the team dir runs
`checkTeamMemSecrets` (`src/memory/memdir/teamMemSecretGuard.ts`, ~40
gitleaks-derived rules in `secretScanner.ts`) and is **blocked**, not warned,
when it matches — the team dir is committed, so a leaked key would be in the
history. The private dir is not scanned.

## Team categories

Team memory is organized by what a teammate needs to find. Three
subdirectories of the team dir carry the product-facing memory; everything
else that is team-scoped (a convention, a process finding) stays at the team
root. **The directory is the category; `type` keeps its four values**
(decisions and bugs are `project`, docs are `reference`), so the scanner,
the permission carve-out and the secret guard needed no change —
`isTeamMemPath` is a prefix test. The `/memory` browser did: it lists the
team dir recursively (`includeNested` in `MemoryDirBrowser.tsx`,
`countMemoryFiles` in `memoryDirRows.ts`), or a categorized file would be
invisible there.

| dir          | holds                                                                 | bar                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions/` | a product / business / architecture decision                          | **structural** (where things live), **functional** (what a feature does for its users) or **rejected** (an alternative discarded with its reason) — AND the why is not in the diff                   |
| `bugs/`      | a known or latent defect deliberately left in place, a failure mode   | confirmed, not fixed in the same session; symptom + where + repro + status with a date                                                                                                              |
| `docs/`      | where the documentation for a subsystem lives, and what it holds      | the document explains the subsystem better than the code does                                                                                                                                       |

The bar for `decisions/` is enforced by its form: the frontmatter adds
`scope:` (feature or slice) and `impact: structural | functional | rejected`,
and the body leads with **Decision / Why / What changes for a teammate /
Rejected / Evidence** — if "what changes for a teammate" would be empty, the
file is not written. Most of a plan's `## Agreed Decisions` are
implementation choices and do not qualify.

The table lives once, in `TEAM_CATEGORIES`
(`src/memory/memdir/memoryTypes.ts`); the system prompt
(`renderTeamCategoriesCompact`), the extraction fork, the dream and
`/memory sort` (`renderTeamCategoriesXml`) all render from it — prose and
status lines elsewhere may *name* the three directories, but each category's
bar is defined there and nowhere else. Index lines
for a categorized memory go under `## Decisions` / `## Bugs` / `## Docs` in
the team `MEMORY.md`, with the subdirectory in the link
(`- [Title](bugs/file.md) — hook`).

Existing team files are **not** moved by the code. `/memory sort`
(`src/commands/memory/sortPrompt.ts`) is the migration: a conservative,
idempotent pass over the team root that `git mv`s a file into a category only
when it unambiguously clears that category's bar, edits only that file's index
line, and adds `paths:` only when the body names concrete files. Each move
goes through the Bash permission prompt — that is the human veto.
`/memory tidy` is unchanged (duplicate merge only) and refuses to categorize.

## On-demand loading: `paths:` on a memory

Only the two `MEMORY.md` indexes are in context every session. A memory file
is read when the model follows its index line — and, since 2026-09-21, a
memory whose frontmatter carries `paths:` is **attached automatically the
first time a Read touches a matching file**, through the same `nested_memory`
lane a path-scoped rule uses:

- same key, syntax and semantics as `.claudin/rules/` (`ruleFrontmatter.ts`);
- same trigger (`FileReadTool` → `nestedMemoryAttachmentTriggers`), same
  once-per-session dedupe and reset on compaction
  (`memoryFilesToAttachments` in `src/agent/attachments/memory.ts`);
- same base directory convention: a project-local memdir anchors its globs at
  the directory containing `.claudin/`, like the project's rules; any other
  memdir location anchors at the original cwd, like Managed/User rules.

The one difference from rules is the default: a rule without `paths:` is
always-on, a memory without `paths:` is index-only. A `paths:` that
normalizes to nothing — `**` alone, or a malformed value — leaves a memory
index-only too, where it would make a rule always-on.

What the transcript shows follows the same split. The line at session start
names the indexes, not the memories — `Loaded private memories index (16
entries), team memories index (122 of 129 entries) — index truncated`
(`src/agent/ui/messages/memoryIndexLine.ts`; "Loaded 16 memories" read as if
the files had entered context; "private"/"team" are the names `/memory` uses
for the two directories) — and a `paths:` match renders as what it
loaded: `Loaded 4 team bug memories`, or `2 rules, 3 team bug memories` when
one Read pulled in both (`nestedMemoryBatchLabel` in
`src/agent/ui/collapseNestedMemory.ts`, from the file's AutoMem/TeamMem type
and its category directory; the paths stay under ctrl+o). A lone file shows
its path, like a lone rule.

An explicit `Read` of a memory file is the third case, and it reads the same
way. The count leaves the collapsed read/search badge — where it used to be
a verb, `recalling 1 memory, recalling 2 team memories…` — for its own
`⎿  Loaded 1 memory, 2 team memories` line under it (`formatMemoryRecallCounts`
in `src/agent/ui/messages/memoryRecallLine.ts`, private clause first, the
same nouns `nestedMemoryBatchLabel` uses; no category breakdown, since the
group carries counts rather than paths). What stays on the badge is what the
group did rather than what arrived — `searched team memories`, `wrote 2 team
memories`. Every memory read is already subtracted out of the badge's
`readCount`, so a group of nothing but memory reads has no badge parts left
at all: the line then stands alone and takes over the `(ctrl+o to expand)`
hint the badge would have carried.

`src/memory/memdir/pathScopedMemories.ts` keeps a `{path, globs}` index of
the memdir, memoized per process and re-read only when the mtime of a walked
directory changes — five or six stats per Read, not one open per memory
file. Only the matches are read in full (`processMemoryFile`, so they get
the frontmatter strip and read-gate bookkeeping a rule gets). Known limit:
editing the `paths:` of an existing file in place does not bump its
directory's mtime, so that change is picked up by the next scan trigger.

The LLM relevance recall (`findRelevantMemories`, a Sonnet side-query per
turn, flag `tengu_moth_copse`) was deleted the same day: two on-demand
mechanisms for one purpose, one of them dead by flag. Transcripts recorded
before then may still carry a `relevant_memories` attachment; the consumers
treat it as an unknown legacy type and render nothing.

## What the dream reads

Auto-dream (`src/memory/autoDream/`) and `/dream` file team decisions, bugs
and docs directly into the team dir when team memory is active — the commit
is the review gate. To judge with data, the harness hands the fork a
**digest** (`dreamDigest.ts`) of the period since the last consolidation,
built before the fork starts so the fork never runs git:

- plans modified since then (`.claudin/plans/`): their `## Context` and
  `## Agreed Decisions`, plus a blast radius counted from the `files:` lines
  of `## Tasks` (files, slices, new files) — a one-file plan is almost never
  a structural decision;
- the session index (`firstPrompt`, `customTitle`, `summary` per session, as
  `getSessionFilesLite` derives them from the head and tail of each
  transcript — `firstPrompt` is the user's own prompt text, clipped to
  `promptChars`; the transcript body, where a paste may hold a secret, is
  never handed over);
- the commit subjects since then filtered to `feat`, `refactor` and breaking
  (`!`) — the `type(scope)!:` convention `git-conventions.md` already
  enforces is the impact classifier the team maintains for free.

Everything is capped (`DEFAULT_DIGEST_CAPS`), and a source that fails to read
is left out.

## Verified unaffected

- Permission carve-outs (`isAutoMemPath()` in
  `src/permissions/filePermissions/internalPaths.ts`) are computed dynamically
  from `getAutoMemPath()`, so reads/writes are still auto-approved with no
  prompt after relocation, including under the category subdirectories.
  `.claudin` was already in `DANGEROUS_DIRECTORIES`
  (`src/permissions/filePermissions/dangerousPaths.ts`) regardless of whether it's global
  or project-local, so no new prompt is introduced.
