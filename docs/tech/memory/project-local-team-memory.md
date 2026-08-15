# Project-Local, Git-Trackable Team Memory

**Status:** Default ON for git projects. Set `autoMemoryProjectLocal: false`
in settings.json (user/local/policy — never projectSettings, for security)
to force the legacy global-only location.
**Scope:** `src/memory/memdir/paths.ts`, `src/memory/memdir/memoryMigration.ts`,
`src/memory/memdir/teamMemPaths.ts`, `src/memory/memdir/teamMemPrompts.ts`

## Problem

Claudin's auto-memory (private notes + the `team/` subfolder) used to live
entirely outside the repo, under
`~/.claudin/projects/<sanitized-git-root>/memory/`. "Team" memory was meant
to reach collaborators via a server-mediated sync
(`src/memory/teamSync/`) that requires first-party Anthropic OAuth
*and* a `github.com` remote. Claudin is explicitly provider-agnostic and not
Anthropic-account-bound, so that sync path never activates for most Claudin
users — including any project hosted on a self-hosted git server (Gitea,
GitLab CE, Bitbucket Server, etc.). Team memory ended up stuck local-only for
everyone who isn't both on Anthropic OAuth and GitHub.

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

## Verified unaffected

- Permission carve-outs (`isAutoMemPath()`/`isTeamMemFile()` in
  `src/services/permissions/filesystem.ts`, `src/services/session/sessionFileAccessHooks.ts`)
  are computed dynamically from `getAutoMemPath()`/`getTeamMemPath()`, so
  reads/writes are still auto-approved with no prompt after relocation.
  `.claudin` was already in `DANGEROUS_DIRECTORIES`
  (`src/services/permissions/filesystem.ts`) regardless of whether it's global
  or project-local, so no new prompt is introduced.
