---
name: Provider pointer heal — open follow-ups
description: febf362a fixed the saveGlobalConfig projects clobber + added startup heal for dangling provider pointers; three known gaps remain unfixed
type: project
---

Commit febf362a (2026-06-12) fixed saveGlobalConfig discarding updater edits to `projects` (root cause of dangling project provider overrides — deleteProviderProfile's M4 cleanup never persisted) and added a startup heal in claudinStartupMigrations.ts. Known gaps deliberately left as follow-ups:

1. **Mid-session window**: addProviderProfile/updateProviderProfile/persistActiveProviderProfileModel persist sanitize-rejected profile drops without reconciling project/global pointers — heal only runs at startup, so pinning stays broken until restart. STILL OPEN.
2. **Cache GC**: ✅ FIXED 2026-07-18 (feat/kimi-code-oauth-provider) — `pruneOrphanedModelOptionsCache()` startup heal in claudinStartupMigrations.ts drops `openaiAdditionalModelOptionsCacheByProfile` entries with no matching profile id. Idempotent.
3. **/provider migrate** doesn't rerun runClaudinStartupMigrations despite CLAUDE.md claiming migrations are rerunnable via that command. STILL OPEN — so startup heals (Kimi model-list, cache GC) are only reachable on a real restart, not via `/provider migrate`.

Also note (F5 landmine closed 2026-07-18): `persistActiveProviderProfileModel`/`clearActiveProviderProfileModel` (providerProfiles.ts) — the two dead-but-exported functions that mutate `profile.model` — now invalidate the derived model-options cache (delete per-profile entry + clear flat) like updateProviderProfile, so wiring them into a live flow won't reintroduce the stale-`/model` bug. No production caller yet.

**Why:** heal design decisions matter for these — dangling-ness is decided against RAW stored profile ids (sanitize-invisible profiles from branch builds are NOT deleted; the claudin/claudindev dual-binary setup depends on this).
**How to apply:** any fix to the write paths or migrate command should reuse stripProjectProviderPointers (providerProfiles.ts) and keep the raw-id semantics.
