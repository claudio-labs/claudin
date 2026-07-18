---
name: Durable coding gotchas go in .claudin/rules/, not team memory
description: Project convention — path-scoped rule files own renderer/cache/testing/agent-safety/build coding gotchas; team memory is reserved for project state, decisions, and external references
type: feedback
---

In this repo, a durable **coding gotcha or invariant** belongs in a
`.claudin/rules/*.md` file (auto-loaded when an edited file matches the rule's
`paths`), NOT as a team memory. Team `memory/team/` is reserved for project state,
decisions, and external references that are not coding rules. Current rules:
`ink-tui.md` (forked Ink renderer), `cache.md` (prompt/tool-result cache),
`testing.md` (mock leaks, known full-suite flakes, typecheck baseline),
`agent-safety.md` (sub-agent/worktree hazards — has NO `paths`, so it is always-on),
`build-system.md` + `typescript-patterns.md` (feature()/`--compile` constraints),
`search-strategy.md` (module map). Repeatable procedures go in a skill (e.g.
`/add-provider-preset`), not a memory.

**Why:** On 2026-07-17 the user directed a consolidation of ~28 team+private
memories into these rules/skills. Rules reach the point of use with far less
always-on context than an unbounded team-memory index, and path-scoping means the
gotcha only loads when you edit the relevant subsystem. A rule with no `paths`
frontmatter applies to all files (always-on) — use that only for genuinely
cross-cutting guidance like agent-safety.

**How to apply:** When you learn a durable coding gotcha (renderer internals, cache
invariants, test-mock hazards, worktree/sub-agent safety, build/compile
constraints), add or extend the matching rule in `.claudin/rules/` rather than
writing a team memory. Keep team memory for state/decisions/references. When
consolidating, on close read keep "shipped X" memories that carry an opt-out env
var or an open follow-up (not purely derivable), and surface that rather than
deleting as "derivable".
