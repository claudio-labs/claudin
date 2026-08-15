---
name: mechanical-rewrites-skip-producers
description: A repo-wide path rewrite updates derived artifacts but not the code that produces them — and rewrites recorded results it should have left alone; the 2026-08 reorg hit both, five times, each silent
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

The same walk has a second failure direction, found on 2026-08-15: it also
rewrites files that are **records rather than text**, and there the update is
the corruption. It edited 106 of them — 38 bench transcripts under
`scripts/bench/results/`, 62 archived discovery notes under `docs/archive/`, and
`scripts/profile/baselines/cold-start-retained.json`, whose measured RSS and
import-time figures ended up filed under module names that were never measured.
Verbatim model output now cited slice paths nobody could have typed on the day
it was produced. All 106 were reverted and `scripts/reorg/apply.ts` now skips
those trees (`isRecordedArtifact`).

And one gate was left mid-migration: `scripts/missing-imports-baseline.json`,
the pin behind `build:strict`, was last captured in reorg group 3 of N. Every
later group moved importers, so 53 specifiers were unbaselined and 55 baselined
ones no longer existed — `CLAUDIN_STRICT_IMPORTS=1 bun run build` failed on the
branch while a plain `bun run build` stayed green and merely printed the count.
That is the one gate whose whole job is catching a path gone stale after a move.
Re-captured 2026-08-15; the module set was identical, so nothing had actually
broken, only the guard.

A path-pinned mechanism also lives outside the repo, and that one cannot be
fixed in the same commit: **CodeQL keys a dismissal to a file path**, so every
move resurrects the finding. PR #93 re-raised the same five high alerts that
were already reviewed and dismissed as false positives twice — the sanitizer
fixpoint loop in `toolResultSummarizer.ts` (×3), and the two opaque-ID hashes in
`classifierProbeStore.ts` / `betaSessionTracing.ts`. Their dismissal comments on
main literally read "Rename re-raise (PR #88); was #12", because #88 did it the
time before. Expect one red CodeQL check per reorg, do not "fix" the code for
it, and re-dismiss with the same reasons plus the new alert numbers. The third
generation is `#26`–`#30` (`src/permissions/classifierProbeStore.ts:43`,
`src/platform/telemetry/betaSessionTracing.ts:119`,
`src/agent/tools/toolResultSummarizer.ts:1250` ×3), dismissed 2026-08-15 while
PR #93 was still open — the check run flipped to success without a merge, so
dismissing pre-merge works once the branch's paths are final. Two mechanics
worth knowing before the next round: the repo is on CodeQL **default setup** (no
workflow, no `.github/codeql*` config), so there is no query filter to add and
inline `// codeql[…]` suppression is not a documented code-scanning feature —
the API dismissal is the only lever; and `dismissed_comment` is capped at **280
characters**, which a 422 tells you only after the PATCH.

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
the destination). Re-run every ratchet the move could have desynced —
`build:strict`, `test:floor`, the typecheck baseline — as part of the move, not
after someone notices. And decide up front which trees are records: a bench
result, a captured baseline and an archive are evidence, and evidence is not
maintained. See [[rule-files-two-silent-failure-modes]] for the same shape in
rule frontmatter, and [[reorg-catch-all-dirs-retired]] for the reorg itself.
