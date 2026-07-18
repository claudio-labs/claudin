---
name: Provider pointer heal — open follow-ups
description: febf362a fixed the saveGlobalConfig projects clobber + added startup heal for dangling provider pointers; three known gaps remain unfixed
type: project
---

Commit febf362a (2026-06-12) fixed saveGlobalConfig discarding updater edits to `projects` (root cause of dangling project provider overrides — deleteProviderProfile's M4 cleanup never persisted) and added a startup heal in claudinStartupMigrations.ts. Known gaps deliberately left as follow-ups:

1. **Mid-session window**: addProviderProfile/updateProviderProfile/persistActiveProviderProfileModel persist sanitize-rejected profile drops without reconciling project/global pointers — heal only runs at startup, so pinning stays broken until restart.
2. **Cache GC**: orphaned `openaiAdditionalModelOptionsCacheByProfile` entries are never collected (heal/delete only prune the specific dangling/deleted id).
3. **/provider migrate** doesn't rerun runClaudinStartupMigrations despite CLAUDE.md claiming migrations are rerunnable via that command.

**Why:** heal design decisions matter for these — dangling-ness is decided against RAW stored profile ids (sanitize-invisible profiles from branch builds are NOT deleted; the claudin/claudindev dual-binary setup depends on this).
**How to apply:** any fix to the write paths or migrate command should reuse stripProjectProviderPointers (providerProfiles.ts) and keep the raw-id semantics.
