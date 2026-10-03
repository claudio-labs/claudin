---
name: config-default-mode-copies-project-permissions
description: Changing "Default permission mode" in /config writes the MERGED permissions into the user settings.json, so a project's .claudin/settings.json allow rules leak into user scope (every project) — pinned, not fixed (2026-10-02)
type: project
paths:
  - src/platform/settings/ui/Config.tsx
  - src/platform/settings/settings.ts
---

**Symptom:** after changing "Default permission mode" in `/config`, the user-level `settings.json`
gains every `allow`/`deny` rule that was in effect in the current project. That includes rules that
came only from the project's `.claudin/settings.json`, and from then on they apply in every project.

**Where:** the `/config` dialog (`src/platform/settings/ui/Config.tsx`). It saves the merged
`permissions` object, not the user layer.

**Repro:**
1. Put an `allow` rule in a project's `.claudin/settings.json`.
2. Open `/config` and change "Default permission mode".
3. Read the user `settings.json`: the project's rule is now in it.

**Status:** pinned as current behaviour in `Config.characterization.test.tsx` by the 2026-10-02 cover round
(branch `rewrite`). It is listed in `docs/tech/rewrite/levers-findings.md` (on `rewrite`) as
security-relevant. Not fixed.

**Why not fixed:** cover rounds pin behaviour without changing it. The fix belongs in its own change, or in the
per-method rewrite of the settings slice. The pin then changes in the same commit.
