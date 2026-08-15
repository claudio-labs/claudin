---
name: rule-files-two-silent-failure-modes
description: A .claudin/rules/ file can be silently inert or silently unconditional; both look identical to a working rule at runtime — this is what verify:rules, the /doctor line and /refresh-rules were built to catch (2026-08-07)
type: project
---

Rule files are injected into context with **no validation of any kind** — no zod
schema on the frontmatter, no glob check, no existence check on cited paths.
Two failure modes follow, and neither produces any runtime signal.

**Class A — inert.** `parseFrontmatterPaths` (`src/memory/instructions/claudemd.ts`) hands
patterns to `ignore().add(...)` — the *gitignore* library, not a glob matcher.
It accepts nearly any string, so a `paths:` matching no file leaves the rule
permanently unloaded and indistinguishable from a working one.

**Class B — silently unconditional, and expensive.** Only `paths` is read.
A rule authored with `globs:` (the Cursor convention, common enough that
`/create` carries a migration note) gets no patterns, falls into the
unconditional lane, and loads into **every session, every turn**. One wrong
frontmatter key turns a scoped rule into a permanent context tax, invisibly.

**Why:** the only telemetry on that path is
`tengu_claude_rules_md_permission_error`, EACCES only.

**How to apply:** three surfaces now exist, all over `src/memory/instructions/rulesLint.ts` —
`bun run verify:rules` (CI + `/pre-pr`, hard-fails both classes), a `/doctor`
line under "Context Usage Warnings", and `/refresh-rules` for the semantic half
no checker can see. Two things learned building it, worth keeping:

- **Prose-path checking needs a project anchor or it is pure noise.** The first
  version reported 15 findings, ~13 of them false: npm specifiers
  (`react/compiler-runtime`), prose (`add/rm`), flag lists (`-A/-B/-C`), paths
  relative to somewhere else (`RunTestsTool/run.ts`). The fix that works is
  requiring the citation's **first segment to be a real directory at the project
  root** — project-agnostic, no hardcoded list. Plus `.js`→`.ts` resolution for
  TS import specifiers, and skipping lines that say the thing was removed
  (AGENTS.md documents the deleted `src/grpc/` on purpose).
- **`execFileNoThrow` ignores a `cwd` option** — it only honors `useCwd` and
  reads the process cwd, so it cannot run a command in another directory. Use
  `execFileNoThrowWithCwd`, or `child_process` directly as
  `src/tools/TypecheckTool/baseline.ts` documents (unrelated suites
  `mock.module` that specifier for the whole `bun test` run, and it drags in the
  analytics graph, which makes any module importing it unusable from
  `scripts/`). That last point is why rule-frontmatter parsing lives in the leaf
  module `src/memory/instructions/ruleFrontmatter.ts` rather than in `claudemd.ts`.

See [[repo-map-rejected-orientation-measured]] for why upkeep was built instead
of an index generator.
