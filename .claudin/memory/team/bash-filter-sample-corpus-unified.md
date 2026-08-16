---
name: Bash filter samples live in ONE dir since 2026-08-06
description: The docs/discovery sample copy was merged into src/tools/shared/outputFilter/Bash/__fixtures__/samples/; don't recreate the mirror, and mind which fixtures a harness actually loads
type: project
---

**Scope:** this file owns WHERE the corpus lives, why the mirror was merged and
which fixtures a harness actually loads. The byte-length rule for EDITING a
sample is [[bashfilter-fixtures-byte-length-sensitive]].

The bash output filter's sample corpus is **one directory**:
`src/tools/shared/outputFilter/Bash/__fixtures__/samples/` (142 `.txt` + a README).

Until 2026-08-06 (commit e3b730b8) it existed twice, and the split was
load-bearing in both directions — which is why neither copy could just be
deleted:

- `bashFilter.test.ts` (602 assertions) and `phase12Report.test.ts` (31) read
  `docs/discovery/bash-output-filter/validation/samples/`
- `scripts/bench/tokens/measure-bash-filter-roi.test.ts` and
  `scripts/bench/perf/bash-filter-gain.test.ts` read `__fixtures__/samples/`

`phase12Report` loaded ~28 samples (shellcheck, hadolint, jj-log, prisma-*, the
gradle/mvn/terraform sets) that existed only under `docs/`. The 21 files that
differed were not rival measurements: all 21 were `claudio` → `claudin` drift,
and `find.txt`/`npm-ls.txt` still described the gRPC service deleted in #22.

**Do not recreate the mirror.** The validation harness was pointed at the src
corpus and has since been archived to
`docs/archive/discovery/bash-output-filter/validation/validate.ts`. The 2026-08
reorg left its sample specifier behind on a `src/outputFilter/…` path that no
longer exists (same class as [[mechanical-rewrites-skip-producers]]); repointed
at `src/tools/shared/outputFilter/Bash/__fixtures__/samples` on 2026-08-15 and
re-run, so `bun run docs/archive/.../validate.ts` works again — but it
**overwrites `validation/results.md` in place**, and that file is a dated
2026-05-05 snapshot taken against samples several of which have since been
re-captured (`git-diff.txt` 0→3.2 KB, `wget.txt` 522 B→5.3 KB). A re-run is not
reproducible against it: 66/67 OK with `wget` now missing its own prediction
(96% actual vs 72%). Revert `results.md` after running unless you mean to
replace the record.

Two traps when touching samples:

- **Byte length is load-bearing** — see
  [[bashfilter-fixtures-byte-length-sensitive]] before any find/replace.
- **Pick a fixture the harness actually loads** when mutation-testing. Gutting
  `pytest-real.txt` or `git-blame.txt` fails nothing — neither harness loads
  them, though both appear in `FIXTURE_MAP`. 87 of the 142 are unmapped and are
  silently listed under "Skipped (no mapping)"; the ROI table measures 55.
