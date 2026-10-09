---
name: global-user-memory-dir
description: Since 2026-10-09 (branch feat/global-memory) a third auto-memory dir, ~/.claudin/memory/, holds what is about the user in every project — type user always, feedback that holds anywhere; the guard sends user memories there and keeps project ones out
type: project
scope: memory
impact: structural
---

**Decision:** auto memory has a third directory, the global one (`<memoryBase>/memory/`,
`~/.claudin/memory/` by default, `autoMemoryGlobalDirectory` from trusted settings only), read
by every project. `type: user` always goes there; `feedback` goes there when it holds in any
project and names nothing of this one; `project` never. The model judges per memory; the
format guard refuses `type: user` in the private/team dirs and `type: project` or `paths:` in
the global one. Writes are auto-approved like the private dir's, for the main agent and both
forks; the dream may add and update there but never prunes. `CLAUDIN_GLOBAL_MEMORY=0` turns it
all off and every prompt reads as before.

**Why:** the user asked for it — what is about the person (pt-BR, answer depth, a taste for
clean architecture) was stuck in whichever repo learned it, so each new project started blind.
The type does not decide the split on its own: of this repo's 21 private feedback memories, about
half were about the person and half about Claudin, so a type-based migration would carry
project rules everywhere.

**What changes for a teammate:** a memory test fixture writing `type: user` under the private
dir is refused while the global dir is on — set `CLAUDIN_GLOBAL_MEMORY=0` or write it under
`getGlobalMemPath()`; a test that resolves memory paths must isolate `CLAUDIN_CONFIG_DIR`, or it
touches the real `~/.claudin/memory/`. Prompt texts now come in two variants (with and without
the global dir): `teamMemPrompts.test.ts` mocks `isGlobalMemoryEnabled` per case. The
transcript, `/context` and `/memory` name the three indexes from `memoryIndexNames.ts`.
`/memory sort` is the migration (private → global, each `mv`/`rm` prompted); the code moves
nothing on its own.

**Rejected:** migrating every `type: user` file automatically (mixed files like a user
profile that also describes this project's work would carry the project part along);
moving all feedback (Claudin rules would load in every repo); asking before every global write
(the background forks cannot ask, so passive learning would stop); a dream that prunes the
global dir (a run sees one project, so it would delete what holds elsewhere). Accepted risk: a
memory planted by a hostile repo now reaches every project — contained only by the recall
framing (background context, not instructions) and the transcript showing each write.

**Evidence:** plan `.claudin/plans/dapper-tickling-meerkat.md`; design doc section "Global
memory" in `docs/tech/memory/project-local-team-memory.md` ([[memory-subsystem-design-doc]]);
memory-write A/B `/tmp/memory-write-ab/20261009-154413` (N=3, five requests): 15/15 in the
global, no-global and placebo arms, $0.104 vs $0.100 vs placebo $0.094 per session; probes
`scripts/migrations/probes/global*.json`, every probe red.
