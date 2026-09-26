---
name: team-memory-git-is-the-sync
description: 2026-09-21 — the server-mediated team-memory sync and the per-turn LLM memory recall were deleted; git is the sync, `paths:` on a memory is the on-demand loader, the team dir gained decisions/ bugs/ docs/ and a blocking secret guard
type: project
scope: memory
impact: structural
paths:
  - "src/memory/**"
---

**Decision:** Team memory reaches teammates through ordinary commits and
nothing else. `src/memory/teamSync/` (the HTTP sync to
`api/claude_code/team_memory`, ~1,950 lines) and
`src/memory/memdir/findRelevantMemories.ts` (a Sonnet side-query per turn
picking "relevant" memories, flag `moth_copse`) were deleted on
2026-09-21 (branch `feat/memory-v2`). What replaced them: a `paths:`
frontmatter key on a memory file, loaded through the rules' `nested_memory`
lane the first time a Read touches a matching file; three category
subdirectories under the team dir (`decisions/`, `bugs/`, `docs/`, defined
once in `TEAM_CATEGORIES`); `/memory sort` as the migration; and a secret
guard that *blocks* a write into the team dir on a gitleaks-derived match.

**Why:** The sync activated only with first-party Anthropic OAuth *and* a
`github.com` remote — never for a provider-agnostic fork, and never on a
self-hosted git host — so team memory was local-only for everyone while
carrying the code of a server product. The LLM recall was dead by flag and
was a second on-demand mechanism for the one purpose `paths:` now serves at
zero model cost (five or six stats per Read, one memoized index). The
categories exist because a flat team dir of 129 entries had outgrown the
24 KB index cap: the index is what enters context every session, so the
organizing principle has to be "what a teammate needs to find".

**What changes for a teammate:** A file written into `.claudin/memory/team/`
shows up in `git status` and ships with your commit — that is the whole
sync, and the commit is the review gate. A secret-shaped string there is
refused, not warned about (`checkTeamMemSecrets`, on all four write tools).
A memory tied to specific files gets `paths:` (same syntax as a rule) and
then rides along automatically; a memory without it is index-only, which is
the opposite default from a rule. Team decisions go in `decisions/` only
when they clear the bar in the doc (structural / functional / rejected AND
the why is not in the diff). `verify:privacy` bans the old endpoint, so the
sync cannot come back quietly.

**Rejected:** keeping the sync behind a provider gate (no user could reach
it); keeping the LLM recall as a fallback for memories without `paths:`
(two mechanisms, one of them paid per turn); a `category:` frontmatter key
instead of directories (the directory is visible in `ls`, in the index link
and to the prefix test without any code change).

**Evidence:** `docs/tech/memory/project-local-team-memory.md` (the design
doc — see [[memory-subsystem-design-doc]]); the unbiased audit of the branch
on 2026-09-21 (all gates green, 50 probes, secret-guard test gap closed the
same day by `teamMemSecretGuard.test.ts` + `probes/teamMemSecretGuard.json`).
