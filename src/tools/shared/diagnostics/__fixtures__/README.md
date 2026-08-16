# Verbatim checker output

Captured by `scripts/bench/ab/capture-checker-output.sh`, which runs each checker
for real inside its official container. Nothing here is hand-written — that is
the entire point.

A parser written from a remembered output format is a guess, and the guess
passes its own unit test. `deno check` was parsed for `error: TS2551 [ERROR]: …`,
a shape Deno does not emit; the test was green and the tool degraded on every
real run. These files are the evidence the tests are written against.

`<name>.txt` is the command the tool actually issues, injected flags included.
`<name>-noflags.txt` is the same command without the injection — that pairing is
what exposed two flags we were adding that break the run rather than shape it:

- `dotnet build --no-restore` on a never-restored project fails with NETSDK1004,
  formatted exactly like a compiler diagnostic and positioned inside the .NET
  SDK. The flag is now conditional on `obj/project.assets.json` existing, and
  `NETSDK*`/`MSB*` codes fail the run instead of being reported and baselined.
- `mvn -o` (offline) cannot resolve plugins against a cold `~/.m2`, so the check
  never runs on a fresh clone or in CI. Removed, along with gradle's
  `--offline`; neither shapes output.

To refresh: `scripts/bench/ab/capture-checker-output.sh [dart|dotnet|maven|gradle|phpstan|psalm]`
