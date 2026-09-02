---
name: A tool module must not statically import the tools.ts registry
description: static import of src/tools.js (or a module that transitively does) from inside a tool def crashes startup with a bundler TDZ in AgentTool's eager buildTool
type: feedback
---

A tool definition (or any module the tool-registry eagerly loads) must NOT statically import `src/tools.js` — directly or transitively (e.g. via a heavy engine module that imports `assembleToolPool`, `runAgent`, or `agentToolUtils`).

**Why:** `tools.ts` assembles the registry eagerly and pulls in `AgentTool.tsx`, whose top-level `export const AgentTool = buildTool({...})` reads `outputSchema` during construction, which calls `agentToolResultSchema()` (a `lazySchema` const defined in `agentToolUtils.ts`). If a new static import edge merges `AgentTool.tsx` and `agentToolUtils.ts` into the same bundler chunk in the wrong order, `buildTool` runs before the `const agentToolResultSchema` initializes → `TypeError: agentToolResultSchema is not a function` at startup (import-cycle TDZ). Confirmed 2026-07-06: `AGENT_WORKFLOWS` on crashed, off didn't. `runAgent.ts:304` already documents avoiding this by taking its tool pool from the caller instead of importing `tools.ts`.

**How to apply:** load the heavy/engine module lazily from inside the tool's `call()` — `const { runWorkflow } = await import('../engine.js')` — never at module top. Repro is bundle-only: `bun run build` then `CLAUDIN_CONFIG_DIR=$(mktemp -d) node dist/cli.mjs -p hi` (a clean `Not logged in · /login` means module init passed). `--version` won't catch it (fast-path skips the registry). Bisect by toggling the feature flag off/on and rebuilding.
