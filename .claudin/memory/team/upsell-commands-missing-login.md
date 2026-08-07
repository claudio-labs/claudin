---
name: upsell-commands-missing-login
description: /upgrade and /extra-usage render a <Login> component that does not exist in this fork, so both hang blank
type: project
---

`src/commands/upgrade/upgrade.tsx:8` and `src/commands/extra-usage/extra-usage.tsx:4`
both `import { Login } from '../login/login.js'`. **`src/commands/login/` does not
exist in this fork.** The build's missing-module pre-scan stubs it to
`export const Login = () => null`, so the returned `<Login …/>` renders nothing
and its `onDone` never fires — the command sits in its running state showing a
blank body until the user presses Ctrl-C.

Both are reachable by default:
- `/upgrade` — `availability: ['claude-ai']`, enabled unless
  `DISABLE_UPGRADE_COMMAND` is set or the subscription is `enterprise`. It DOES
  successfully open `https://claude.ai/upgrade/max` first; only the login step
  that follows is dead.
- `/extra-usage` — enabled when `isOverageProvisioningAllowed()` and the session
  is interactive.

Also stale: `upgrade.tsx:22` tells the user to "run `/login`", and there is no
`/login` command in this fork — Anthropic sign-in lives in `/provider`.

Not fixed as of 2026-08-06 because the right answer is a product call, not a
mechanical one: these are Anthropic-billing upsells in a project that is not
affiliated with Anthropic. The options are to drop the login step and finish the
command with a pointer to `/provider`, or to remove both commands. Found while
reducing the typecheck backlog — see [[typecheck-backlog-shape]].
