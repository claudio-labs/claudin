---
name: headless-sync-plugin-install-broken-import
description: CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true HUNG headless -p for months on a stale relative import — fixed in PR #57; keep the discriminator that separates a real TS2307 from the fork's expected ones
type: project
---

`src/cli/print/turnLoop.ts` imported `'../utils/plugins/loadPluginHooks.js'`, which
resolves to `src/cli/utils/plugins/` — a directory that does not exist. The real
module is `src/utils/plugins/loadPluginHooks.ts`. The specifier had been one level
short since `2e178cf7` moved `runHeadless` from `src/cli/` into `src/cli/print/`
without re-basing it. **Fixed 2026-08-07 in PR #57** (`2e0d4ecc`), using the `src/`
path alias rather than `../../`.

## The symptom was a hang, not an error

Only `runHeadlessStreaming.ts` sets `pluginInstallPromise`, and only under
`CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, so ordinary `-p` never reached it. When it did
fire, the rejected dynamic import left `run()` unfinished and the output stream
never closed — the process produced **zero bytes and never exited**. Measured on
one build, `-p` with a trivial prompt:

| env var | result |
|---|---|
| unset | exit 0, full JSON result |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=true` | no output, killed at 90s |
| same, after the fix | exit 0, full JSON result |

Also worth knowing: `setup.ts` deliberately skips arming the hot reload in
sync-install mode to avoid racing the install, so that was the *only* call site
arming it there — plugin-hook hot reload was simply dead on that path too.

## The reusable part — triaging a TS2307 in this fork

This sat inside the ~107-entry `TS2307` cluster that
[[missing-subsystems-are-not-fixable-by-declaration]] correctly says is the fork's
expected shape, which is exactly why nobody looked at it. The discriminator that
separates a real bug from that backlog is two questions, both cheap:

1. **Does the target exist somewhere in the tree?** A sweep of `src/cli/print/`
   found three unresolvable relative specifiers. `../../proactive/index.js` and
   `../../utils/udsMessaging.js` have no target anywhere — expected. This one's
   target existed.
2. **Is the call site behind a disabled `feature()` gate?** The other two are
   (`PROACTIVE`, `UDS_INBOX`), so they are dead-code-eliminated. This one sat in a
   plain `if`.

Target exists **and** call site ungated ⇒ real bug, regardless of how much the
diagnostic looks like its neighbours.

## And the rule it vindicates

`typescript-patterns.md` bans `../../` parent imports with the reason "breaks on
file moves". This was that rule's textbook case: a file changed directory depth and
a relative specifier rotted silently. When fixing one, use the `src/` alias — a
second relative path just re-arms the trap. Dynamic `await import('src/…')` works
fine through the bundler; `sessionLoad.ts` and `settingsControlHandlers.ts` already
rely on it.

See also [[tier3-file-split-roadmap]].
