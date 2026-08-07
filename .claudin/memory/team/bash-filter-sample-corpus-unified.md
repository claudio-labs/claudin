---
name: Bash filter samples live in ONE dir since 2026-08-06
description: The docs/discovery sample copy was merged into src/outputFilter/Bash/__fixtures__/samples/; don't recreate the mirror, and mind the byte-length constraint
type: project
---

The bash output filter's sample corpus is **one directory**:
`src/outputFilter/Bash/__fixtures__/samples/` (142 `.txt` + a README).

Until 2026-08-06 (commit e3b730b8) it existed twice, and the split was
load-bearing in both directions — which is why neither copy could just be
deleted:

- `bashFilter.test.ts` (602 assertions) and `phase12Report.test.ts` (31) read
  `docs/discovery/bash-output-filter/validation/samples/`
- `scripts/measure-bash-filter-roi.test.ts` and
  `scripts/profile/bash-filter-gain.test.ts` read `__fixtures__/samples/`

`phase12Report` loaded ~28 samples (shellcheck, hadolint, jj-log, prisma-*, the
gradle/mvn/terraform sets) that existed only under `docs/`. The 21 files that
differed were not rival measurements: all 21 were `claudio` → `claudin` drift,
and `find.txt`/`npm-ls.txt` still described the gRPC service deleted in #22.

**Do not recreate the mirror.** `docs/.../validation/validate.ts` now reads the
src corpus via `../../../../src/outputFilter/Bash/__fixtures__/samples`.

Two traps when touching samples:

- **Byte length is load-bearing** — the harness asserts a reduction
  *percentage* per sample, so scrubs must preserve length (`viudes` → `devusr`,
  `claudio` → `claudin`). See [[bashfilter-fixtures-byte-length-sensitive]].
- **Pick a fixture the harness actually loads** when mutation-testing. Gutting
  `pytest-real.txt` or `git-blame.txt` fails nothing — neither harness loads
  them, though both appear in `FIXTURE_MAP`. 87 of the 142 are unmapped and are
  silently listed under "Skipped (no mapping)"; the ROI table measures 55.
