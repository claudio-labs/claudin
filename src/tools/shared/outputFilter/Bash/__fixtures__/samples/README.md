# Bash output filter — sample corpus

142 real command outputs, and the **single** copy of them in this repo.

They used to exist twice: here and in
`docs/discovery/bash-output-filter/validation/samples/`. Each consumer read one
or the other, so a fixture added to one was invisible to half the suite, and
the two drifted a whole rebrand apart — 21 files differed, entirely on
`claudio` → `claudin` and on the gRPC service deleted in #22 (`find.txt` and
`npm-ls.txt` still listed `scripts/grpc-cli.ts` and `@grpc/grpc-js` on the docs
side).

Everything now reads this directory:

| Consumer | What it does |
|---|---|
| `src/tools/shared/outputFilter/Bash/bashFilter.test.ts` | the ROI + safety harness (most of the assertions) |
| `src/tools/shared/outputFilter/Bash/phase12Report.test.ts` | Phase 12 per-filter report |
| `scripts/bench/tokens/measure-bash-filter-roi.test.ts` | prints the ROI table; reads the whole dir, maps names via `FIXTURE_MAP` |
| `scripts/bench/perf/bash-filter-gain.test.ts` | bench, opt-in with `CLAUDIN_BENCH=1` |
| `docs/archive/discovery/bash-output-filter/validation/validate.ts` | the original discovery runner, kept as a research artifact |

## Adding a sample

Capture straight into this directory:

```bash
<command> > src/tools/shared/outputFilter/Bash/__fixtures__/samples/<name>.txt 2>&1
```

Then map it in `FIXTURE_MAP` (`scripts/bench/tokens/measure-bash-filter-roi.test.ts`) if it
should count toward the ROI table — an unmapped `.txt` is listed under "Skipped
(no mapping)" instead of failing, and 87 of the 142 currently are.

Two constraints before you edit an existing file:

- **Byte length is load-bearing.** The harness asserts a reduction *percentage*
  per sample, so scrubbing has to preserve length — that is why the usernames
  here read `devusr` rather than a shorter placeholder.
- **Non-`.txt` files are ignored**, which is what makes this README safe to keep
  beside the corpus.
