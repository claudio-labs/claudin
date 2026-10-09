# Project-Local, Git-Tracked Team Memory

**Status:** Default ON for git projects. Set `autoMemoryProjectLocal: false`
in settings.json (user, flag or policy — never projectSettings or settings.local.json, which live in the repo)
to force the legacy per-project location under the config home
(`~/.claudin/projects/<…>/memory/`). That is not the global memory
(`~/.claudin/memory/`, [below](#global-memory)), which the setting does not
affect.
**Scope:** `src/memory/memdir/paths.ts`, `src/memory/memdir/memoryMigration.ts`,
`src/memory/memdir/memoryScopes.ts` and `src/memory/memdir/memoryDirs.ts` (the
directories, below),
`src/memory/memdir/teamMemPaths.ts`, `src/memory/memdir/teamMemPrompts.ts`,
`src/memory/memdir/memoryTypes.ts` (the team categories and `TYPE_SCOPES`),
`src/memory/memdir/pathScopedMemories.ts` (on-demand loading),
`src/memory/autoDream/dreamDigest.ts` (what the dream reads),
`src/commands/memory/sortPrompt.ts` (`/memory sort`) and
`src/memory/memdir/memoryFormatGuard.ts`.

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

`getPrivateMemPath()` (`src/memory/memdir/paths.ts`) now defaults to
`<gitRoot>/.claudin/memory/` for any project inside a git repository — the
same project-local pattern already used for `.claudin/plans/`
(`src/agent/plans/plans.ts`), with the same symlink-escape containment check and
fallback to the legacy per-project path under the config home if verification
fails or the project isn't a git repo. `getTeamMemPath()` derives from `getPrivateMemPath()`, so the
`team/` subfolder moves along with it automatically.

Resolution order (first match wins):

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (Cowork only)
2. `autoMemoryDirectory` in settings.json (trusted sources only)
3. `<gitRoot>/.claudin/memory/` when `autoMemoryProjectLocal` isn't `false`
   and the realpath-verified containment check passes
4. `<memoryBase>/projects/<sanitized-git-root>/memory/` (the legacy
   per-project path under the config home)
   — used for non-git projects and whenever step 3 can't be verified safe

### Migration

The first time the project-local path resolves for a project whose legacy
per-project directory already has memory content, `migrateLegacyMemoryIfNeeded()`
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

Every Edit/Write/Patch/staged write into the team dir runs
`checkTeamMemSecrets` (`src/memory/memdir/teamMemSecretGuard.ts`, ~40
gitleaks-derived rules in `secretScanner.ts`) and is **blocked**, not warned,
when it matches — the team dir is committed, so a leaked key would be in the
history. The private dir is not scanned.

## Global memory

The two directories above both belong to a project, so what is about the
**person** — their language, how much detail they want in an answer, a taste
for clean architecture — stayed in whichever repo it was learned in, and every
new project started knowing nothing about the user. Since 2026-10-09 a third
directory holds that: the **global** memory, `<memoryBase>/memory/`
(`~/.claudin/memory/` by default), read by every project.

### One registry for the three directories

Global, private and team are **scopes**, and two modules are the only place
that knows them:

- `memoryScopes.ts` — pure: `MEMORY_SCOPES` (general to specific, the order
  the indexes load and every surface lists them in) and `MEMORY_SCOPE_SPECS`,
  what each one is called (its getMemoryFiles type, its `/memory` row, title,
  description, delete note and subcommand), plus `ENTRYPOINT_NAME`. The
  transcript, `/context` and `/memory` name the directories from here.
- `memoryDirs.ts` — which directories are in use and where:
  `getMemoryDirs()` (none while memory is off; global only while it is on),
  `findMemoryDir(dirs, path)` / `memoryScopeOf(path)` (the deepest root wins,
  so a file under `team/` is team, not private), `memoryScopeForPermission(path)`
  (the same, with every symlink on the way required to stay in that
  directory), `promptRoots(dirs)`.

`MEMORY_SCOPE_SPECS` also carries what differs between the scopes as data —
`dirMode`, `hasSubdirectories` (the team categories: `/memory` counts and
browses them, the transcript names them), `takesPaths` — so a caller asks the
spec rather than testing `scope === 'team'`.

Everything that asks "is this memory, and whose?" asks there: the permission
carve-outs, the format guard, the forks' tool gate, the extraction manifest,
getMemoryFiles, the transcript's badges, the freshness note, `/memory`'s rows
and the prompts of the dream, tidy and sort. The one exception is the team
secret guard, which keeps `isTeamMemPath`: the team dir is git-tracked, so a
write there is scanned whether memory is on or not.

### Where each type goes: `TYPE_SCOPES`

`memoryTypes.ts` `TYPE_SCOPES` states each type's scope once, global dir on
and off, and what the guard enforces in the global dir (`only`, `allowed`,
`never`). Both system prompts, the extraction's verbose taxonomy, the sort's
promotion part, the write rules and the guard's refusals all render that text,
so none of them can drift from another. The dream and tidy prompts do not
restate it: they point at the system prompt's `# Memory` section, which their
forks share.

With the global dir on: `user` always global (what holds of the user only in
this project is a private `project` memory); `feedback` global when it would
still hold in an unrelated repo, private when it would not or when unsure,
team only for a project-wide convention; `project` never global; `reference`
usually team, global only for a personal resource. The type alone does not
decide it: of this repo's 21 private feedback memories when it shipped, about
half were about the person and half about Claudin.

- **Where:** `getGlobalMemPath()` (`src/memory/memdir/paths.ts`). The setting
  `autoMemoryGlobalDirectory` moves it — from policy, flag or user
  settings only, like `autoMemoryDirectory` — which is
  also how the memory-write bench points it at its workspace. Created 0700 by
  `loadMemoryPrompt` (the scope's `dirMode`). The `user`-scope agent memory already lived beside it, at
  `<memoryBase>/agent-memory/`. Either setting is refused when it would hold
  the config home: a memory directory is read and written with no prompt, so
  `~/.claudin` itself would put `settings.json` under that carve-out.
  The three settings are read from policy, flag and user settings only:
  `settings.local.json` lives in the repo too, so it moves no memory dir.
  A repo rooted at `$HOME` would make its project-local private dir
  `~/.claudin/memory/` itself; its private dir goes to the legacy per-project
  location instead, so no project's memory reads as global.
- **When:** `isGlobalMemoryEnabled()`, which is `globalMemoryOffReason() ===
  null` — on with auto memory, off with `CLAUDIN_GLOBAL_MEMORY=0`, off under a
  Cowork memory override (the caller gets exactly the directory it
  designated), and off when settings make the global and private dirs nest.
  `/memory global` reports that same reason. `getMemoryDirs()` leaves it out while it is off, so every
  check built on the registry — the carve-out included — goes with the switch,
  and the prompts name two directories.
- **The guard** (`memoryFormatGuard.ts`): with the global dir on, a type whose
  `TYPE_SCOPES` entry is `only` (`user`) is refused outside it, quoting its
  scope and saying how to move a file saved before the global dir existed; a
  `never` type (`project`) and a `paths:` key (the scope's `takesPaths`) are
  refused in it. Where a type may live is judged only for a file that is new
  or changes its type, so a memory saved before a rule existed stays
  updatable in place — by every tool alike. No secret scan — it is never
  committed, like the private dir.
- **Context:** its `MEMORY.md` loads as `'GlobalMem'`, before the private and
  team indexes — general to specific, the way the user's CLAUDE.md precedes
  the project's — under the same caps. `pathScopedMemories.ts` does not scan
  it: a global memory is index-only. The transcript says `Loaded global
  memories index (4 entries), private memories index (…)`, and a recall
  `Loaded 2 global memories, 1 private memory`.
- **Framing:** the indexes do not ride under the instructions' preamble
  ("These instructions OVERRIDE any default behavior…"). `getClaudeMds`
  renders AGENTS.md, CLAUDE.md and the rules first, then the indexes under a
  preamble of their own — background context, checked against the current
  state, instructions taking precedence — because an index line is written by
  a past conversation: a teammate's in the team index, any project's in the
  global one.
- **Permissions:** read and write with no prompt, the same carve-out as the
  private dir (`internalPaths.ts`), for the main agent and both forks. The
  carve-out asks `memoryScopeForPermission`: the path, every symlink it
  resolves through and its target must stay in that one directory, so a
  symlink committed under `.claudin/memory/` leads nowhere silently. The risk
  accepted with it: a memory planted by a hostile repo now reaches every
  project, not only that one. What contains it is the framing above, and
  every write showing in the transcript.
- **Forks:** both forks run under `createMemoryCanUseTool(['global'])`
  (`createExtractionCanUseTool` for the extraction): in the global dir an Edit
  or Write passes only when it adds — an Edit whose new text keeps the old, a
  new file, a Write that keeps the file's content — because a run sees one
  project and what looks stale here may hold in another. Both prompts say so.
  The extraction skips a range where the main agent already wrote a memory —
  with Write, Edit or Patch (`writtenPaths.ts`) — and lists the global dir in
  its manifest. The dream names a global memory this project contradicts in
  its summary instead of fixing it. A manual `/dream` runs in the
  conversation with normal permissions, so there it is the prompt alone.
- **/memory:** a `Global memory` row first, `/memory global` to open it (a
  delete there warns that every project loses the memory; with the global dir
  off it says why — `CLAUDIN_GLOBAL_MEMORY=0`, a Cowork override, or the two
  dirs nesting — instead of opening the dialog); `/memory tidy` covers it and
  never merges across directories; `/memory sort` is the migration — it
  promotes what is about the user from the private dir: a `mv -n` (never over
  a global file of the same name, which another project saved — a name
  collision is compared, then merged or moved under a new name), a merge into
  an existing global memory, or a split of a file that mixes the person with
  the project. Each `mv` and `rm` is behind the permission prompt; a split's
  new global file, a merge's edit and the index edits are written without one
  (the memory carve-out), so the prompt names them and has the model list
  them in its report. The code moves nothing on its own. A user who upgrades
  with `type: user` memories in a project's private dir sees it on the
  `Private memory` row — `· 3 about you — /memory sort moves them to global`
  (`countGlobalOnlyMemories` in `memoryDirRows.ts`). The two instruction files
  above the directories are `User instructions` (`~/.claudin/CLAUDE.md`) and
  `Project instructions` (`AGENTS.md`/`CLAUDE.md`) — instructions, as the
  context calls them, not memory.
- **/context:** each index is named as above, with its entry count and the
  `/memory` subcommand that manipulates it; `/context` itself stays read-only.

## Team categories

Team memory is organized by what a teammate needs to find. Three
subdirectories of the team dir carry the product-facing memory; everything
else that is team-scoped (a convention, a process finding) stays at the team
root. **The directory is the category; `type` keeps its four values**
(decisions and bugs are `project`, docs are `reference`), so the scanner,
the permission carve-out and the secret guard needed no change —
`isTeamMemPath` is a prefix test. The `/memory` browser did: it lists the
team dir recursively (`includeNested` in `MemoryDirBrowser.tsx`,
`countMemoryFiles` in `memoryDirRows.ts`, both from the scope's
`hasSubdirectories`), or a categorized file would be invisible there.

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
goes through the Bash permission prompt — that is the human veto; the
frontmatter keys and the index edit are written without one, and the report
lists them.
`/memory tidy` is unchanged (duplicate merge only) and refuses to categorize.

## On-demand loading: `paths:` on a memory

Only the `MEMORY.md` indexes are in context every session — two, or three
with the global dir. A memory file
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

When no index exists yet, or every one is empty, the memory section says so
right after that sentence — "Both are empty — nothing is saved yet.", or
"All three are empty" with the global dir (`teamMemPrompts.ts`). Without it
a fresh project's model opened them to
check: 2 of 5 session-cache-ab runs on 2026-09-24 did. `loadMemoryPrompt`
(`memdir.ts`) decides it on the memoized `getMemoryFiles()` load the indexes
reach context through, so the prompt agrees with what the model was given and
a mid-session rebuild of the prompt sections cannot flip it.

The one difference from rules is the default: a rule without `paths:` is
always-on, a memory without `paths:` is index-only. A `paths:` that
normalizes to nothing — `**` alone, or a malformed value — leaves a memory
index-only too, where it would make a rule always-on.

What the transcript shows follows the same split. The line at session start
names the indexes, not the memories — `Loaded global memories index (3
entries), private memories index (16 entries), team memories index (122 of
129 entries) — index truncated`
(`src/agent/ui/messages/memoryIndexLine.ts`; "Loaded 16 memories" read as if
the files had entered context; "global"/"private"/"team" are the names
`/memory` uses for the directories) — and a `paths:` match renders as what
it loaded, named by its scope like a Read of one: `Loaded 2 private
memories`, `Loaded 4 team bug memories`, or `2 rules, 3 team bug memories`
when one Read pulled in both (`nestedMemoryBatchLabel` in
`src/agent/ui/collapseNestedMemory.ts`, from the scope of the file's type —
`scopeOfIndexType` — and, in a scope with subdirectories, its category
directory; the paths stay under ctrl+o). A lone file shows its path, like a
lone rule.

An explicit `Read` of a memory file is the third case, and it reads the same
way. The count leaves the collapsed read/search badge — where it used to be
a verb, `recalling 1 memory, recalling 2 team memories…` — for its own
`⎿  Loaded 1 private memory, 2 team memories` line under it (`formatMemoryRecallCounts`
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
turn, flag `moth_copse`) was deleted the same day: two on-demand
mechanisms for one purpose, one of them dead by flag. Transcripts recorded
before then may still carry a `relevant_memories` attachment; the consumers
treat it as an unknown legacy type and render nothing.

## Write rules on demand

Since 2026-09-29 (team memory `claude-code-2.1.284-wire-diff`) the v2 memory
section — `buildLeanCombinedMemoryPrompt`, the Anthropic family — carries only
what every request needs; the full prompt of the other families is unchanged.

- **What stays in the prompt** (what every request needs): where the
  directories live (two, three with the global dir), remember/forget, the
  frontmatter template, the four types, one line saying `decisions/`, `bugs/`
  and `docs/` exist with rules of their own, "only the two (or three)
  `MEMORY.md` indexes are in context" (with the empty-index note), what to save (update rather than duplicate, skip what
  the code and git history hold), the secrets rule, recall, and the
  past-context search.
- **What moves out** (what only a write needs), into
  `buildMemoryWriteRules(teamDir)` in `teamMemPrompts.ts`: the `[[name]]`
  links line, the three category lines with their bar (rendered from
  `TEAM_CATEGORIES` as before), and the index, `paths:`, update and skip
  rules. About 1.1k characters of ~3.6k.
- **The guard** — `checkMemoryFileFormat` in `memoryFormatGuard.ts`, beside
  `checkTeamMemSecrets` on the same four write paths, each handing it the
  whole file as it will be — an Edit builds it from the file on disk — so a
  file gets one verdict whichever tool writes it. A `.md`
  under any memory dir, never a `MEMORY.md`, is refused when its
  frontmatter lacks `name`, `description` or a valid `type`; when a team file
  is `type: user`; when a category file's `type` is not its category's
  (decisions and bugs `project`, docs `reference`); or when a decision lacks
  `scope:` or an `impact:` of structural / functional / rejected. The refusal
  names what is missing and carries `buildMemoryWriteRules`. What the
  extraction and dream forks write passes (`memoryFormatGuard.test.ts` builds
  its fixtures from `MEMORY_FRONTMATTER_EXAMPLE`).
- **The advice** — `memoryIndexAdvice`, the Write and Patch tools' `advise`:
  a memory file its directory's index does not link to yet gets a note with
  the index-line rule (the section, for a category file). An index line
  written in the same response gets none — by the same Patch, or by a Write,
  Edit or Patch beside it (`indexTextFromResponse`; `advise` runs before the
  calls after it, so it reads them from `ToolUseContext.responseToolUses`).

The guard applies to every family, and asks for nothing their prompts do not
already state. Its checks are format checks, so the rules no check can
enforce — update rather than duplicate, skip what the code holds — stay in
the prompt as well.

How it was measured: the session A/B `/tmp/session-cache-ab/20260929-231527`
(no regression, with the rest of the first-request dedup) and the memory-write
check `scripts/bench/ab/memory-write-ab.ts` (`/tmp/memory-write-ab/20260929-230343`,
N=3 × four requests): 12/12 sessions wrote each memory in its place with a
complete frontmatter and its index line, as the full-rules baseline did. A
decision's first write was refused once per session for its missing
`scope:`/`impact:`, then written right; every new memory got the index note.
A write of a memory file that is already malformed — by any tool — is refused
until its frontmatter is fixed.

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

- Permission carve-outs (`memoryScopeForPermission()`, called from
  `src/permissions/filePermissions/internalPaths.ts`) are computed dynamically
  from `getMemoryDirs()`, so reads/writes are still auto-approved with no
  prompt after relocation, including under the category subdirectories.
  `.claudin` was already in `DANGEROUS_DIRECTORIES`
  (`src/permissions/filePermissions/dangerousPaths.ts`) regardless of whether it's global
  or project-local, so no new prompt is introduced.
