---
name: rule-files-two-silent-failure-modes
description: A .claudin/rules/ file can be silently inert, silently unconditional, or carry wrong facts inside a fenced block; all three look identical to a working rule at runtime — the third is now checked and auto-healed (2026-08-07, shipped 2026-08-17)
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

**The lesson that changed the design:** part of what was filed as "the semantic
half no checker can see" is in fact **mechanical** — path existence, `(N)` file
counts, `file.ts (symA, symB)` attributions, `~N lines` claims. It only looked
semantic because the extractor never reached it.

**Shipped 2026-08-17**, and it settled the generation question this project kept
reopening ([[repo-map-graph-topology-degenerate]],
[[repo-map-rejected-orientation-measured]]). What was rejected is generated
**judgment**; generated **structure** is a different object, because every
statement in it is one the checker re-derives. So a map is now written in every
project and kept current, and it is allowed to say very little:

- `rulesClaims.ts` — extraction, pure. `rulesLint.ts` — report. `rulesMapSync.ts`
  — rewrite. `ruleMapAutoSync.ts` — run at session start, killswitch
  `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`.
- **A hand-written map is healed, never restructured** (numbers only). **A
  generated one is regenerated whole**, with `←` annotations carried across by
  the directory's FULL path — keying them by bare name gave `src/ui/` and
  `app/ui/` one shared gloss. The marker `<!-- claudin:module-map -->` is what
  distinguishes the two: we only restructure files we wrote.
- Counts follow a `git ls-files` extension histogram, so a Python repo counts
  `.py`. Nothing is hardcoded to TypeScript.

Four things the plan got wrong, all found by running it rather than reading it:

- **The cheap check is not the product.** Fenced *path* existence catches 1 of
  the 3 misleading defects and is the part that needs the tree parser. Size and
  attribution catch the other two and need no tree — both resolve by **unique
  basename**, ambiguous → skipped.
- **A size claim must sit in the parenthetical its filename opens.** "Nearest
  filename to the left" read *"eight lines of a 2,200-line file"* as a claim
  about the `FileReadTool.ts` cited beside it — the only false positive, and it
  was in `cache.md`, not the map.
- **Two guards keep the tree parser honest**: only `├──`/`└──` lines are entries,
  and the `←` annotation is split off before tokenizing. Without the second,
  every annotated line invents a path (`← model.ts` under `providers/` →
  `src/providers/model.ts`): 14 false findings in one run.
- **Symbol lists need a code-shaped filter** (interior capital or `_`), or
  `activeProvider.ts (resolver)` reads as an attribution.

The tolerance question is settled as **relative, ±10% with a floor of 3**: 9 of
55 counts had drifted within two days of being measured, so an exact ratchet is a
permanently red check and a permanently red check gets deleted. Both halves earn
their place on that same sample — the largest absolute drift was `transport/`
(35→37, 5.7%, inside ±10%), the largest relative one was `__tests__/` (6→8,
**33.3%**, three times over it and silenced only by the floor). Small directories
swing wildly in relative terms; that is what the floor is for.
**The tolerance has to apply on the regeneration path too**, and the first cut
missed that — only hand-written maps consulted it, so a generated map re-rendered
exact counts and ONE added file rewrote the tracked file at every session start,
inverting the entire cost argument. Counts inside tolerance are now carried over
verbatim, so an unchanged structure re-renders byte-identical.

Four more defects the review round caught, all of which produced a wrong path or
a wrong number rather than a crash: the tree parser divided a variable-width
indent by a fixed 4 (every two-space tree reported its children as missing);
regeneration targeted the first fence in the file rather than the tree's (a
prose example above it was overwritten); a dead directory healed to `(0)` instead
of being reported; and a count rewrite searched from the start of the line, so
two siblings sharing a number healed the wrong one.

**Not measured:** whether a generated map helps in a fresh project. Every number
above came from this repo, which already had a 467-line hand-written map. The
case for shipping it everywhere is that its claims are verified, not that its
value is proven.

**Method note, because it nearly went the other way.** Two read-only review
agents (the `agent-safety.md` §4 round) found the regeneration-tolerance bug and
five others; the empirical break-and-restore pass that followed found one of the
*new* tests was tautological — it pinned a duplicate-`(N)` line whose naive
implementation happened to be correct for that input. Reproducing the bug needed
two siblings sharing a number where only the second drifted. Read-only agents
cannot run that pass, so budget for it separately rather than assuming a green
suite means the guards hold.
