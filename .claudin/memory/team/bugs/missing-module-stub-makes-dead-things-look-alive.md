---
name: missing-module-stub-makes-dead-things-look-alive
description: The build's missing-module stub exports a TRUTHY default, so `feature(TRUE_FLAG) ? require(absent) : null` registers a phantom — plus the two commands that can only fail because of a neutralized constant
type: project
paths:
  - "src/platform/install/download.ts"
  - "src/platform/main/commands/install.ts"
  - "src/platform/entrypoints/mcp.ts"
---

Audited 2026-09-15. Three live defects share one root: something that cannot
work still *looks* wired, because the thing standing in for it is truthy or
empty rather than absent.

## The truthy stub (a class of bug, belongs in build-system.md)

`scripts/build/build.ts:707` serves every unresolved relative import
`const noop = () => null; export default noop`. **A function is truthy.** So

```ts
const x = feature('SOME_FLAG') ? require('./absent/index.js').default : null
…
...(x ? [x] : [])
```

registers `noop` whenever the flag ships **true**. `FORK_SUBAGENT` is true and
`src/commands/fork/` was never mirrored, so the slash-command list carried an
entry named `noop` (the arrow function's inferred `.name`). Fixed by dropping
the require; the flag stays on, it gates the Agent tool's fork-by-default
behaviour, not a command.

`src/commands/__tests__/registry.characterization.test.ts` now fails on this
shape anywhere in that table — it resolves every gated `require` and refuses a
true flag with no `.ts`/`.tsx`/`.js` behind it. A `.d.ts` deliberately does not
count.

## `claudin install` can only fail — UNRESOLVED, needs a product call

`src/platform/install/download.ts:31` sets `GCS_BUCKET_URL = ''` (deliberately
neutralized — it pointed at Anthropic's distribution bucket). `getLatestVersion`
ends at `getLatestVersionFromBinaryRepo(channel, '')`, which asks axios for a
relative URL and throws. `installLatest` → `updateLatest` → `getLatestVersion`
is the **entire body** of the command, which is registered in
`src/platform/main/commands/install.ts` and visible in `--help`.

So the GCS half is not unreachable dead code you can quietly delete: it is the
only thing the command does. Options are to remove `claudin install` with the
native `install/` path, repoint it at the npm updater that already exists in
`autoUpdater.ts`, or leave it. **Do not touch the rest of `install/`** — the npm
updater is live with 38 importers.

## `claudin mcp serve` cannot list tools — FIXED 2026-11-26

`tools/list` answered `-32603 Custom types cannot be represented in JSON
Schema`. Unrelated to the stub: the three AgentWorkflow tools declare
`z.custom<Output>()` output schemas, and the handler converted every output
schema, so one throw failed the list. `listToolsForMcpServe` now drops an
unconvertible output schema from its tool and leaves out a tool whose input
schema cannot be converted ([[opencode-mcp-ports]]);
`src/platform/entrypoints/mcp.serve.e2e.test.ts` drives the bundle.

Fixed in the same round: the server announced itself as `claude/<codename>`
(`serverInfo.name` in `startMCPServer`, `src/platform/entrypoints/mcp.ts`) to every connecting client — see
[[defingerprinting-branch-2026-08]] for what identity is still upstream-spelled.
