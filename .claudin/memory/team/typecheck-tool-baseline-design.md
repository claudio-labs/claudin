---
name: Typecheck tool — baseline design and the exec output-truncation trap
description: Why TypecheckTool keys its pre-existing-error baseline on a clean git tree, and the BASH_MAX_OUTPUT_LENGTH truncation that silently caps exec() output for anything that parses it
type: project
---

`src/tools/TypecheckTool/` (branch `feat/typecheck-tool`, 2026-08-03) is the
RunTests-shaped wrapper for the type-check step: detect the checker, run it,
report only the diagnostics missing from a recorded backlog. Twelve checkers —
tsc, deno, cargo, pyright, mypy, go, dart, dotnet, maven, gradle, phpstan,
psalm. It exists because `main` carried **4623 pre-existing `tsc` errors** when
it was built (2026-08-03 — a dated snapshot, not a fixed figure; `main` reads
2820 on 2026-08-07, and [[typecheck-backlog-shape]] says how to read it live),
so raw compiler output is unusable in context and nothing distinguished an error
the agent caused from one that was already there.

**Baseline mechanism (the load-bearing decision).** When `git status --porcelain`
is empty, every diagnostic is pre-existing *by definition*, so the run's
fingerprints are persisted for that HEAD sha in project-local
`.claudin/cache/typecheck-baseline.json`. No second compile, no worktree, no git
mutation. Consequences that are easy to get wrong:

- Fingerprints hash file + code + message and **exclude line/column**. With a
  backlog thousands deep, a line-based key would re-report thousands as "new"
  after a one-line insertion.
- Comparison is a **multiset**, not a set: three copies of a once-baselined error
  means two are new.
- Entries under `.claudin/` are filtered out of the clean-tree check, and
  `.claudin/cache/` is added to the global gitignore — otherwise the cache file
  itself dirties the tree and the feature disables itself on first use.
- Capturing at a NEW commit diffs against the previous one and reports
  `+N introduced since <sha>`, closing the hole where committing broken code on
  a clean tree launders those errors into the backlog.
- SHA-1 truncated to 12 chars, NOT `hashContent` — that helper returns Bun.hash
  under Bun and SHA-256 under Node, and this value is written by a Node CLI and
  read back by Bun tests.

**The trap worth remembering beyond this tool:** `exec()` (utils/Shell.ts) caps
`result.stdout` at `BASH_MAX_OUTPUT_LENGTH` (default **30 000 chars**) — the
full text stays on disk at `result.outputFilePath`
(`utils/ShellCommand.ts:306-315`). Anything that PARSES shell output must read
that file or it silently summarises a large run from its first few hundred
lines. RunTests had the same latent bug on its text-scrape path; both now use
`readFullShellOutput()` in `src/services/shell/fullOutput.ts`.

**Three traps that only a LIVE run against the real binary exposes** (unit
fixtures written from memory passed for all three):

- `exec()` has NO cwd option — it runs in the session's persistent shell. It
  agrees with `getCwd()` for a plain REPL turn, so the bug hides; a sub-agent
  under a cwd override (worktree isolation) checked the MAIN checkout and filed
  the results under the worktree path. Wrap as `cd '<cwd>' && { … }` with
  `preventCwdChanges: true`. **Any tool that shells out and takes a cwd needs
  the same check** — RunTests included.
- `FORCE_COLOR=0` DOES NOT disable colour: deno (and anything else testing only
  for the variable's PRESENCE) reads it as a request to colourise and overrides
  `NO_COLOR=1`. Unset it instead. Parsers now strip ANSI in `parseCheckerOutput`
  as belt and braces.
- `deno check` prints `TS2322 [ERROR]: msg` with NO `error:` prefix, and ends
  with a bare `error: Type checking failed.` summary that must NOT become a
  diagnostic (no position → fingerprints at line 0 → permanently "new"). The
  original parser was written against a format Deno does not emit.

**All twelve parsers are now live-validated.** tsc, deno, go, cargo, pyright and
mypy ran on this host; dart, dotnet, maven, gradle, phpstan and psalm ran inside
their official containers via `scripts/bench/capture-checker-output.sh`, which
records each checker twice — once with the flags the tool injects, once without
— and archives the verbatim output in `parsers/__fixtures__/`. That pairing is
what exposes a flag that breaks the run rather than shaping it, and it found two:

- `dotnet build --no-restore` on a never-restored project fails with NETSDK1004
  formatted exactly like a compiler diagnostic and positioned inside the .NET
  SDK — it would have been reported AND baselined. The flag is now conditional
  on `obj/project.assets.json`, and `NETSDK*`/`MSB*` codes fail the run instead.
- `mvn -o` (offline) cannot resolve plugins against a cold `~/.m2`, so the check
  silently never runs on a fresh clone or in CI. Removed, with gradle's
  `--offline`; neither shapes output, so neither belonged in the flag table.

**The baseline is keyed to a sha, so every write path must respect that** (two
fixes, 2026-08-04):

- **`baseline: "capture"` used to skip the clean-tree gate entirely**
  (`const clean = mode === 'capture' ? true : …`), so it filed the errors in
  your UNCOMMITTED work under HEAD's sha and called them pre-existing forever
  after. Both existing guards missed it — the same-sha branch is skipped for
  `capture`, and `introducedSincePrev` only fired when the sha DIFFERED — so a
  forced re-capture absorbed everything silently. It was the one-argument way
  for an agent to make its own breakage invisible, and a bench transcript shows
  a model reaching for it on turn 1 in exactly that state. Capture now degrades
  to `auto` on a dirty tree and says so (`captureRefused`); `introducedSincePrev`
  now also reports a same-sha re-capture.
- **The capture header quoted the DISPLAYED count** while recording every
  diagnostic, so with a `path` filter or `severity: "error"` it understated what
  it had just made permanent. It now reports `recordedCount`.

Both generalise: `path`/`severity` scope the *display*, never the baseline
(`run.ts` fingerprints before filtering, deliberately). Any new header quoting a
number next to the word "baseline" has to come from the recorded set.

**The first check of a session now reconstructs HEAD's baseline in a detached
worktree** (2026-08-04). Dirty tree + no baseline used to mean "provenance
unknown", and two benches showed the model answering that with `git stash` —
the tree-mutating pattern the tool exists to replace. It now runs
`git worktree add --detach` at HEAD, re-runs the checker there, records the
result and classifies against it; the user's tree is never touched. Killswitch
`CLAUDIN_DISABLE_TYPECHECK_WORKTREE=1`. Three design points that are easy to get
wrong:

- **Nest the checkout inside the project** (`.claudin/cache/head-worktree`), not
  `/tmp`. Node module resolution walks UP, so a nested checkout finds the real
  `node_modules` with no symlink. Symlinking `node_modules` into a scratch tree
  would leave the user's real dependency tree one `rm -rf` from deletion.
- **Nesting fixes module resolution but NOT the binary.** The detected command
  is `./node_modules/.bin/tsc`, resolved against the checkout, which has no
  `node_modules` — it exited 127. That is the dangerous failure: 127 parses as
  zero diagnostics, "HEAD was clean" is an ACCEPTED baseline, and the entire
  backlog would have been reported as newly introduced. Found only by
  live-testing with `claudindev`; every unit test passed.
- **`detect.ts` owns where the toolchain lives, via `DetectedChecker.toolchainDir`.**
  The first fix pattern-matched `node_modules/` inside `run.ts` and silently
  missed the other two shapes the detector emits — `./.venv/bin/mypy` and
  `vendor/bin/phpstan` (no `./`) — so reconstruction never fired for Python or
  PHP. A pattern cannot work here anyway: `./gradlew` and `./mvnw` are tracked
  files that DO exist in the checkout and must keep resolving there. The probe
  that picked the path names the directory; `execChecker` re-points exactly that
  and puts it on PATH (needed on its own for `npm run <script>`, where no path
  appears in the command). A caller-supplied `command` has no `toolchainDir`, so
  its reconstruction is discarded rather than guessed at.
- **Gate the result on overlap with the live run** (≥50%). A checkout where the
  checker cannot resolve dependencies does not fail, it emits thousands of
  "cannot find module" errors. An empty reconstruction is accepted (a clean HEAD
  is a valid backlog); a barely-overlapping one is discarded.

The remaining unknown is not the parsers but the payoff — see
[[typecheck-ab-bench-fixture-flaw]].

**Why:** built after the user asked which RunTests-shaped tool would save the
most tokens; the baseline is what makes it usable in a repo with a permanent
error backlog, and the truncation cap invalidates the naive implementation.

**How to apply:** measured 21× smaller payload than raw `tsc` on a 40-error
fixture (`scripts/bench/typecheck-ab.ts`, verified live against sonnet 5) — far
more on this repo. Verify baseline behaviour in throwaway `/tmp` git repos with
`claudindev`, never in this checkout: the lifecycle needs commits and deliberate
breakage. See also [[runtests-tool-language-coverage]] for the per-runner
reporter tiering this mirrors, and [[tool-result-nudges-benched-zero-adoption]]
for why the Bash refusal (not a system-reminder) is the adoption lever.
