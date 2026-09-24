---
name: patch-tool-rename
description: apply_patch's wire name became Patch on 2026-09-24 (user decision) — alias + LEGACY_TOOL_NAME_ALIASES keep old rules/hooks/transcripts working; any census over transcripts must count both names
type: project
scope: tools/ApplyPatchTool
impact: functional
---

**Decision:** the multi-file patch tool is called `Patch` on the wire
(`APPLY_PATCH_TOOL_NAME`), the name its UI already showed. `apply_patch` stays
as `LEGACY_APPLY_PATCH_TOOL_NAME`: the tool's `aliases`, an entry in
`LEGACY_TOOL_NAME_ALIASES` (`src/permissions/permissionRuleParser.ts`), and a
tool_use rename in `deserializeMessagesWithInterruptDetection`
(`src/sessions/conversationRecovery.ts`). The directory and identifiers
(`ApplyPatchTool/`, `ApplyPatchTool`, `APPLY_PATCH_TOOL_NAME`) were kept on
purpose, like `FileReadTool` → `Read`. The format is still "the Codex
apply_patch envelope" wherever a line names its origin.

**Why:** user decision (branch `feat/dev-tools-deferred-advice`).

**What changes for a teammate:**
- A census or bench over `~/.claudin/projects/**/*.jsonl` sees `apply_patch`
  before 2026-09-24 and `Patch` after — count both. `read-gate-corpus.ts`,
  `feature-usage-census.ts`, `session-cache-ab.ts`, `three-cli-ab.ts` and
  `14-oracle-recall.ts` already do.
- Settings rules, hook matchers and `--disallowedTools apply_patch` keep
  working through the legacy-name map; the request path sends `Patch` for old
  tool_use blocks too (normalize.ts resolves aliases), so a resumed pre-rename
  session pays one prefix rewrite.
- Break-probe specs that `find` model-facing text (`patchResubmit.json`,
  `promptFeatureCoverage.json`, `antiNarrationRemoved.json`) were moved to the
  new wording; `patchRename.json` pins the three compatibility paths.

**Rejected:** renaming the directory and identifiers too (~30 more imports for
no behavioural difference).

**Evidence:** full `bun test` green (12,140), system-prompt snapshots
regenerated from `dist/` with a one-line diff each.
