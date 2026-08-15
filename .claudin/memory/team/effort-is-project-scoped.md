---
name: Effort is project-scoped like provider and model
description: Every /effort surface writes projects[].activeEffortForProject; no REPL surface writes settings.effortLevel anymore, and 'auto' is a pin sentinel
type: project
---

Since 2026-07-26, effort follows the same project scoping as provider and model:
the pin lives in `~/.claudin/config.json → projects[<git root>].activeEffortForProject`
and the global `settings.effortLevel` is only the inherited fallback.

**Why:** `/model` was already always project-scoped (`src/providers/model/model.ts:147`),
but `/effort` still wrote `userSettings`, so an effort choice in one repo bled into
every other one.

**How to apply:**
- A new surface that persists effort must call `persistEffortForProject` /
  `pinProjectEffortAuto` / `clearProjectEffortPin` from `src/providers/effort/effort.ts` —
  **never** `updateSettingsForSource('userSettings', { effortLevel })`. No REPL path
  writes the global anymore; it is edited by hand or via `/config`.
- Resolution is centralized in `getInitialEffortSetting()`: pin → global → model
  default. Read the origin with `getProjectEffortOrigin()`, and use
  `getPriorPersistedEffort()` (not `getSettingsForSource`) for "did the user ever
  choose?" decisions like `resolvePickerEffortPersistence`.
- `'auto'` is an explicit pin meaning "model default here", which **shadows** a
  globally pinned level; an absent field means "inherit". `/effort inherit` removes
  the pin. Don't collapse the two.
- The pin is deliberately NOT bound to a provider profile and is NOT cleared by
  `setActiveProviderProfileForProject(null)` (unlike `activeModelForProject`):
  `resolveAppliedEffort` already normalizes per model, so a stale pin can't produce
  an invalid request.
