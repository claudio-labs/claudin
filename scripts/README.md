# `scripts/`

Everything here runs against the repository, never inside the shipped CLI —
with two exceptions, named below. Each directory is a **purpose**, so a new
script has one obvious home; if none of them fits, add a directory rather than
dropping the file at the top level, which is how this became 77 loose files in
the first place.

| Directory | What lives here | Entry points |
|---|---|---|
| `build/` | The bundler and everything that feeds it: `build.ts`, the feature-flag reader, `noTelemetryPlugin`, the ripgrep/sharp vendoring, plus the six guard tests whose subject is one of those files. `missing-imports-baseline.json` is the `build:strict` reference set. | `bun run build`, `build:strict`, `build:compile`, `vendor:*`, `link:dev` |
| `release/` | Assembling and publishing: the per-platform npm packages, the placeholder bootstrap, and the grouped release notes the workflow renders. | `bun run build:packages`, `release-binaries.yml` |
| `verify/` | The CI gates. Privacy scan, rule lint, typecheck ratchet, test floor, PR intent scan, plus the standalone guard tests that have no subject in another group. | `verify:privacy`, `verify:rules`, `typecheck:ci`, `test:floor`, `security:pr-scan`, `smoke:hello` |
| `codegen/` | Anything that writes a file into `src/` or a report: SDK types, skill examples, help snapshots, the coverage heatmap, the spinner preview. | `generate:sdk-types`, `test:coverage` |
| `bench/` | Measurement. Three subdirectories, cut by the question they answer — see below. | `bun run profile*`, and running a file directly |
| `migrations/` | One-shot codemods, committed rather than thrown away so the next person can see what moved and what deliberately did not: the `CLAUDE_*` → `CLAUDIN_*` cut-over, and `reorg/` (the 2026-08 `src/` move, whose `manifest.ts` still answers "where did this file go"). | run by hand, rarely |

At the top level, on purpose:

- `repoRoot.ts` — the **only** file allowed to count `..` levels. Import
  `REPO_ROOT` from it instead of deriving the root from your own depth; a
  hand-counted `resolve(import.meta.dir, '..', '..')` breaks the moment the file
  moves, and it breaks at *runtime*, because `tsconfig.json` only includes
  `src/**` and no typecheck ever looks in here.
- `v8cache-gc.mjs` and `postinstall-warmup.mjs` — **not** dev tooling. These
  ship: `bin/claudin` resolves the first at runtime, the second is the package's
  `postinstall`, and both are listed in `package.json`'s `files`. Moving one
  changes the published tarball.

## The three-way cut inside `bench/`

| | Question it answers |
|---|---|
| `ab/` | Do two or more **arms** differ? Variants, flag states, two CLIs — plus their `.json` configs and capture helpers. A bench here is normally named `*-ab.ts`. |
| `tokens/` | What does **one** state cost, in tokens or bytes? A census, a budget, or a replay over a recorded corpus. |
| `perf/` | Milliseconds, megabytes, heap. Also holds its own harness and instruments (`fixtures.ts`, `preload-stubs.ts`, the heap-snapshot tools). |
| `results/` | Captured runs, as markdown. Written to, not read by, the scripts above. |

The distinction is worth keeping sharp because it did not survive its own first
year: benches comparing arms ended up split across a `bench/` and a `profile/`
directory that no rule could tell apart, and the `measure-*` family sat loose at
the top of `scripts/`. If a new bench does not obviously answer one of the three
questions, that is a sign the bench needs narrowing, not that the cut needs a
fourth column.

## Writing a script here

- Import `REPO_ROOT`; never count `..`.
- **A path built from string segments is invisible to every gate.**
  `join(REPO_ROOT, 'scripts', 'foo.ts')`, a repo-relative literal handed to
  `Bun.file()`, a directory passed to the tool under test — tsc does not see
  them, the build's import pre-scan does not see them, and no rename tool
  rewrites them. Only running the file reports the break. Prefer
  `join(import.meta.dir, 'sibling.ts')` for a neighbour, and grep for the
  literal `'scripts'` before moving anything.
- A guard test belongs beside the file it guards, even when it reads that file
  as text. A guard with no subject in any group belongs in `verify/`.
- `bun test scripts/` runs every test in here and is fast; it is the only thing
  that catches the two traps above.
