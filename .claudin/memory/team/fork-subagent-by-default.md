---
name: Fork-subagent-by-default initiative
description: FORK_SUBAGENT shipped 2026-06-04 — default spawn inherits main's context+cache; named spawn stays fresh; fork ungated + auto-background flipped to opt-in 2026-07-26
type: project
---

Decision (2026-06-04): turn on `FORK_SUBAGENT` so the default agent spawn (no `subagent_type`) **forks** — inherits the parent's full context + prompt cache — while a spawn WITH a `subagent_type` stays a fresh, zero-context, own-cache agent ("no bias"). The two types coexist; the model picks per-spawn by omitting vs naming the type.

Three planned edits: (1) `scripts/build.ts` flip `FORK_SUBAGENT:true`; (2) `AgentTool.tsx` decouple `forceAsync` from fork so fork runs **inline** by default (background becomes orthogonal, governed by the existing `/config` "Auto-background agents" toggle / `autoBackgroundAgentsEnabled`); (3) `forkSubagent.ts` gate fork on that toggle AND remove the `getIsNonInteractiveSession()` line.

**Why:** fork was disabled because it forced ALL dispatches async (~15-30k tk/wave extra) and the headless gate blocked it under `-p`. User wants context+cache reuse as the default; decoupling async removes the disable's cost and the non-deterministic headless orphaning. Removing the headless gate is what unblocks measuring fork vs normal via the `-p` bench at all — fork had NEVER been measured because `-p` silently disabled it.

**How to apply:** treat fork mechanics (FORK_AGENT, buildForkedMessages, prompt.ts wording, schema) as already-implemented — do not rewrite. When this lands, expect fork runs to show cacheR↑ / cacheW↓ vs normal-path. Fork uses `model:'inherit'` and cannot use a different model than the parent (a different model breaks cache reuse).

**IMPLEMENTED (2026-06-04).** All edits landed + verified. Fork inline vs real `claude` (3 reps, both drained): −52% total tokens, −53% read, −59% cacheW, +20% out (more work, not skipped), −32% cost. Two extra fixes were required beyond the plan:
- **`isConfigReadingAllowed()` guard** (config.ts, exported): `isForkSubagentEnabled()` runs at tool-schema build time, BEFORE `enableConfigs()`. Calling `getGlobalConfig()` there throws `Config accessed before allowed.` → default fork ON until config is readable, then honor the toggle.
- **Headless inline, not just gate-removal.** Removing the `getIsNonInteractiveSession()` line alone was NOT enough: `shouldRunAsync` still ORed in `isAutoBackgroundAgentsEnabled()` (default ON) with no session guard, so `-p` forks still routed to background and orphaned (0/3), AND lost cache (headless never sets `renderedSystemPrompt` → recompute fallback). Fix: `autoBackgroundImplicit = isAutoBackgroundAgentsEnabled() && !getIsNonInteractiveSession()`. After fix, headless default path drains Y/Y with cacheR=38k (cache shared). Explicit `run_in_background`/`agent.background`/coordinator/proactive still background.
- Also: `canFork = isForkPath && assistantMessage !== undefined` (programmatic callers omitting it fell through to undefined deref in buildForkedMessages); `run_in_background` kept visible in schema with fork on (no longer forces async → it's a real opt-in).

**AMENDED (2026-07-26) — auto-background is now opt-in and fork is ungated.** The default-ON `autoBackgroundAgentsEnabled` backgrounded *every* spawn, so a parent that launched an `Explore` to consume mid-turn got `async_launched`, dropped the plan it had built around that report, and only saw the findings in the next turn's `<task-notification>` (one observed run: 26 tool uses / 76.8k tokens thrown away, parent re-did the research itself). Three changes:
- `createDefaultGlobalConfig()` → `autoBackgroundAgentsEnabled: false`, and `isAutoBackgroundAgentsEnabled()` reads `=== true` (was `!== false`). `CLAUDE_AUTO_BACKGROUND_TASKS` still forces on.
- New `AgentTool/autoBackground.ts::allowsImplicitAutoBackground()` — even with the toggle ON, one-shot built-ins (`ONE_SHOT_BUILTIN_AGENT_TYPES`) and an explicit `run_in_background: false` never take the implicit path. Before this, `false` was silently overridden, so the parameter had no `false` meaning.
- `isForkSubagentEnabled()` no longer reads config at all (the `isConfigReadingAllowed()` guard from the 2026-06-04 round is gone with it) — **fork is context inheritance, backgrounding is execution mode**. Keeping them on one flag meant "stop backgrounding my agents" also meant "lose context inheritance".

`src/constants/prompts.ts::getAgentToolSection()` and `AgentTool/prompt.ts:91` now both describe fork as inline-by-default, which finally matches the runtime — the old text promised inline while the toggle backgrounded everything.

Still open: agent notifications enqueue at `priority: 'later'` while the mid-turn drain in `query.ts` (~1803) uses threshold `'next'`, so a *genuinely* backgrounded fork's report cannot arrive between two tool calls — only after `isQueryActive` flips false. `LocalShellTask` already uses `'next'`; moving agents there is a behavior change nobody has signed off on.
