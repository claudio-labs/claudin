---
name: global-user-memory-dir
description: Since 2026-10-09 (branch feat/global-memory) a third auto-memory dir, ~/.claudin/memory/, holds what is about the user in every project; memoryDirs.ts is the one registry of the three dirs and TYPE_SCOPES the one statement of where each type goes
type: project
scope: memory
impact: structural
---

**Decision:** auto memory has a third directory, the global one (`<memoryBase>/memory/`,
`~/.claudin/memory/` by default, `autoMemoryGlobalDirectory` from trusted settings only, refused
when it would hold the config home), read by every project. Where each type goes is
`TYPE_SCOPES` (`memoryTypes.ts`): `user` always global, `feedback` global when it would still
hold in an unrelated repo (private when unsure), `project` never global. The model judges per
memory; the format guard enforces the table. Which directory a path is in, and which are on, is
`memoryDirs.ts` (`getMemoryDirs`, `memoryScopeOf`); their names live in `memoryScopes.ts`.
Writes are auto-approved like the private dir's, for the main agent and both forks; the
auto-dream's gate is append-only on the global dir. `CLAUDIN_GLOBAL_MEMORY=0` turns it off.

**Why:** the user asked for it — what is about the person (pt-BR, answer depth, a taste for
clean architecture) was stuck in whichever repo learned it, so each new project started blind.
The type does not decide the split on its own: of this repo's 21 private feedback memories, about
half were about the person and half about Claudin. Two unbiased reviews of the first version
found the dir decision re-derived in ~15 places and the routing rule written 8 times with drift,
hence the registry and the table; the TEAMMEM build flag, always on in the bundle and off under
`bun test`, went with it.

**What changes for a teammate:** ask `memoryScopeOf`/`getMemoryDirs`, never a path prefix of
your own; a new directory is a `MEMORY_SCOPES` entry plus a case in `memoryDirs.ts` `rootOf`.
Scope wording is edited in `TYPE_SCOPES`, never in a prompt. Tests build dir lists with
`src/memory/memdir/__testutils__/memoryDirs.ts` and must isolate `CLAUDIN_CONFIG_DIR`, or they
touch the real `~/.claudin/memory/`. The transcript says "private" where it said bare "memory".
`/memory sort` is the migration (private → global, each `mv -n`/`rm` prompted; the private row
counts what it would move). A tool that writes memory goes through `writtenPaths.ts`, and the
guard judges placement only for a new or retyped file. Memory dir settings are read from
policy, flag and user sources only — `settings.local.json` lives in the repo.

**Rejected:** migrating every `type: user` file automatically (mixed files like a user
profile that also describes this project's work would carry the project part along);
moving all feedback (Claudin rules would load in every repo); asking before every global write
(the background forks cannot ask, so passive learning would stop); a dream that prunes the
global dir (a run sees one project, so it would delete what holds elsewhere). Accepted risk: a
memory planted by a hostile repo now reaches every project — contained by the indexes loading
under their own preamble (background context, below the instructions, which win), the carve-out
following symlinks, the forks being append-only on the global dir, and the transcript showing
each write.

**Evidence:** plan `.claudin/plans/dapper-tickling-meerkat.md`; design doc section "Global
memory" in `docs/tech/memory/project-local-team-memory.md` ([[memory-subsystem-design-doc]]);
memory-write A/B after the second review's fixes `/tmp/memory-write-ab/20261009-203121` (N=3,
five requests): 15/15 in the global, no-global and placebo arms, $0.102 vs $0.102 vs placebo
$0.104 per session (after the first rewrite: 15/15, $0.104 vs $0.101 vs $0.104);
probes `scripts/migrations/probes/{global*,autoMem*,memory*}.json`, every probe red.
