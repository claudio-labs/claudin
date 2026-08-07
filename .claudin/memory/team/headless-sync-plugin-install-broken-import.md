---
name: headless-sync-plugin-install-broken-import
description: CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true crashes headless -p — the loadPluginHooks dynamic import is one directory short and has been since 2e178cf7
type: project
---

`src/cli/print/turnLoop.ts` (was `runHeadless.ts:1861` before the 11b split) does:

    const { setupPluginHookHotReload } = await import(
      '../utils/plugins/loadPluginHooks.js'
    )

From `src/cli/print/` that resolves to `src/cli/utils/plugins/…`, which **does not
exist**. The real module is `src/utils/plugins/loadPluginHooks.ts`, so the correct
specifier is `../../utils/…`. The path was never re-based when `runHeadless` moved
one directory deeper in `2e178cf7` (the 11b split), and the 2026-08-07 controller
split preserved it verbatim as a pure move.

**Reachability:** only the `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true` branch awaits it,
after the initial plugin install completes — so ordinary `-p` runs never touch it
and it throws at runtime, not at build. Nothing catches it there.

**Why it hides:** `tsc` does report it (`TS2307`), but it sits inside the ~107-entry
`TS2307` cluster that is mostly the fork's intentionally-absent subsystems
(see [[missing-subsystems-are-not-fixable-by-declaration]]), so it reads as more of
the expected shape. It is not — this one is a typo in a path whose target is
present.

Left unfixed deliberately: it surfaced during a pure-move refactor and mixing a
behavior fix into that would have made the move unreviewable.
