---
name: rule-files-two-silent-failure-modes
description: A .claudin/rules/ file can be silently inert, silently unconditional, or carry wrong facts inside a fenced block the linter cannot see; all three look identical to a working rule at runtime (2026-08-07, extended 2026-08-17)
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

**Class C — wrong facts inside a fenced block (found 2026-08-17).** The linter
extracts citations with `INLINE_CODE_RE = /`([^`\n]+)`/g` (`rulesLint.ts:40`), so
it scans **single-backtick spans only**. `search-strategy.md`'s Module Map is a
*fenced* block (``` opens at line 208), and inside a fence the lines carry no
backticks — so **none of that tree's 9,600 chars is checked**, 33% of a 28,745-char
always-relevant rule. An audit of its 183 mechanically checkable claims scored
**178 correct (97.3%)**, and all 5 errors sat in that blind region: a directory
that no longer exists (`src/platform/privacy/`), two symbols attributed to the
wrong file (`getPrimaryModel` is `src/providers/presets/providerModels.ts:25`,
`getContextWindowForModel` is `src/agent/context/context.ts:82` — a different
slice), a line count off by 40× (`openaiShim.ts` is 51 lines, a barrel; the impl
is the sibling directory), and one file count (`transport/` is 37, not 35).

**The lesson that changes the design:** part of what was filed as "the semantic
half no checker can see" is in fact **mechanical** — path existence, `(N)` file
counts, `file.ts (symA, symB)` attributions, `~N lines` claims. It only looked
semantic because the extractor never reached it. So the fix for a stale map is a
*verifier*, not a generator: it costs zero prompt tokens, has no staleness
window, and preserves the 178 judgment claims no generator would write. That is
the only surviving proposal from two rounds of repo-map evaluation
([[repo-map-graph-topology-degenerate]]) — extend `lintRuleFiles` to walk fenced
blocks, reusing `citationExists`/`hasProjectAnchor` (`rulesLint.ts:173,188`) and
`scanSymbols`. Open design decision, not yet settled: the counts self-declare as
"approximate" and 8 of 18 top-level ones already drift by 2–7 files, so the
tolerance can be absolute, relative, or auto-updated by `/refresh-rules`.

See [[repo-map-rejected-orientation-measured]] for why upkeep was built instead
of an index generator.
