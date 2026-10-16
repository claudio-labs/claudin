---
name: memory-subsystem-design-doc
description: The memory subsystem — memdir layout, team categories, secret guard, `paths:` on-demand loading, dream digest, what the transcript shows — is specified in docs/tech/memory/project-local-team-memory.md; start there before changing src/memory/
type: reference
paths:
  - "src/memory/**"
  - "src/agent/attachments/memory.ts"
  - "src/agent/ui/collapseNestedMemory.ts"
  - "src/agent/ui/messages/memoryIndexLine.ts"
  - "src/commands/memory/**"
---

**Doc:** `docs/tech/memory/project-local-team-memory.md`.

**Covers:** where the two memory directories live and why (project-local
`<repo>/.claudin/memory/`, `team/` git-tracked through a `.gitignore` carve-out);
the `autoMemoryProjectLocal` opt-out; the three team categories and the bar
each one has to clear (`TEAM_CATEGORIES` in `memoryTypes.ts` is the one
source every prompt renders); the secret guard (`teamMemSecretGuard.ts`,
blocks, team dir only) and, since 2026-10-16, shell writes into the team dir
asking plus `claudin memory audit` (`memoryAudit.ts`); `paths:` on-demand
loading and how it differs from a rule (`pathScopedMemories.ts`, memoized on
directory mtimes); the one renderer a memory gets in every lane, with the team
trust note (`claudemd/memoryBlock.ts`); how an index over its caps is fit
rather than cut (`fitEntrypointContent`); the optional `expires:` date and
where it surfaces; what the dream reads (`dreamDigest.ts`, now with each
session's memory writes and the expired memories); what the transcript lines
mean (`Loaded private memories index (N entries)` vs `Loaded 4 team bug
memories`); and a "Verified unaffected" list of the permission paths.

**Start here when:** adding a memory-related prompt (render from
`TEAM_CATEGORIES`, never restate the taxonomy), touching the attachment lane a
memory rides on, changing what the secret guard scans or where it applies, or
wondering why a memory did or did not load.

**Kept in sync by:** the author of each change to `src/memory/` — the doc is
edited in the same PR (the 2026-09-21 audit treated a sentence in it that the
diff contradicted as a finding, and three were corrected that way).
