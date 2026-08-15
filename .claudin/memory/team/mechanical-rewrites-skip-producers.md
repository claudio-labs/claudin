---
name: mechanical-rewrites-skip-producers
description: A repo-wide path rewrite updates derived artifacts but not the code that produces them; the 2026-08 reorg hit this three times, each silent
type: feedback
---

A repo-wide mechanical rewrite (path alias migration, directory reorg) walks
files. It does not walk the **producers** of files. Anything generated,
path-pinned, or matched by string ends up describing a tree that no longer
exists, and the rewrite makes the stale thing look *more* current, not less.

The 2026-08 screaming-architecture reorg hit this three times, and none of them
failed loudly:

- `scripts/no-telemetry-plugin.ts` pins each stub to the module's **resolved
  file path** via a Bun `onLoad` filter. A filter that matches nothing is not an
  error, and the plugin's own `stubbed N modules` line counts *registered*
  stubs, not applied ones. Moving `dumpPrompts` out of `services/api/` disarmed
  its stub and the real module started shipping — build green, `verify:privacy`
  green too, because that scans the bundle for banned *patterns* and this
  particular module happens to be a no-op.
- `scripts/generate-sdk-types.ts` emitted `./coreSchemas.js` while the
  checked-in output carried the aliased `src/…` specifier, because commit
  4858f7e6 rewrote the generator's **output** and not the generator.
  `verify:sdk-types` had been failing permanently on two import lines.
- `src/terminal/moreright/useMoreRight.tsx` justified its lack of imports with a
  build overlay under `scripts/external-stubs/` — a directory this repo never
  had. The reorg's rewriter dutifully updated the fictional path to match the
  new tree.

**Why:** these all sit downstream of the file walk. A generator, a plugin filter
and a comment are *about* paths rather than *containing* imports, so nothing
type-checks them and no test covered the pinning itself.

**How to apply:** after any tree-wide rewrite, grep the **producers** — build
plugins, code generators, `package.json` script globs, rule `paths:` frontmatter,
skill trigger paths, CI workflow filters — before trusting a green suite. When a
mechanism is path-pinned and its failure mode is "silently does nothing", the
guard must assert the pin resolves, not that the output looks right:
`scripts/no-telemetry-stubs-resolve.test.ts` distinguishes a dead key (module the
fork never received — reported) from a key disarmed by a move (fails, and names
the destination). See [[rule-files-two-silent-failure-modes]] for the same shape
in rule frontmatter, and [[reorg-catch-all-dirs-retired]] for the reorg itself.
