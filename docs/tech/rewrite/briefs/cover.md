# Brief: covering files before a lever edits them

A lever (a cut or a replacement, see [levers.md](../levers.md)) is about to
edit the files your brief names. Each one first reaches its coverage target,
under "Cover before touching" in levers.md. Your tests are also the spec that
the later per-method rewrite of these files will work from. So pin what a
caller can observe, not how the code does it.

## Rules

- Work only inside your sandbox (the directory your brief names). It is a copy of the repository with no git history. Use absolute paths inside it, and run every command with it as the working directory.
- Do not read or write the main checkout (`/home/viudes/projects/claudin`) or the openclaude clone, and run no git command.
- **Change no production file.** Add tests, fixtures and test harnesses only. If a line can only be reached by changing production code, leave it uncovered and report it.
- Run only targeted tests (`bun test <paths>`), because a whole-repo run fails in a sandbox without git. Do not run `bun run build`.
- The shell is shared with other agents. Use absolute paths, and never kill processes by pattern (`pkill -f`, `pgrep | kill`): another agent's run may match. Stop only a process you started, by its PID.

## Deliverables

1. **Characterization tests** next to each file, as `<name>.characterization.test.ts(x)`. Where a colocated suite already exists, add a new file rather than editing it.
   - **Target.** Every file of your unit reaches its target: providers 80%, shared 75%, and 70% everywhere else. To measure, run your tests together with the existing suites that load the file:
     ```sh
     bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage <test files>
     bun run rewrite:coverage --unit <unit>
     ```
     The second command must exit 0. A run limited to these suites undercounts, so passing it is conservative.
   - **Not the cut.** Do not pin behaviour that the cut in levers.md ("The cuts", including the classified remote files) is about to delete. Those lines still count against the file's total, so cover the surviving behaviour more thoroughly instead.
   - **Black box.** Test through the module's exports, as its callers use them. To find the callers, grep the sandbox for imports of each file.
   - **Real inputs.** Use real files, directories and processes, and a fresh `mkdtemp` per test. Point `CLAUDIN_CONFIG_DIR`, and every other path or variable the code reads, at temp directories: never the real `~/.claudin`, and never the repository's own `.claudin`. Build git repositories in temp directories, with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and `HOME` at a temp directory.
   - **Mocks.** Mock only at a boundary the code cannot be driven through, such as a model call or the network, and follow `.claudin/rules/testing.md`. A `mock.module` stays in force for the whole run, and that rule says how to keep it from leaking into other files.
   - **Ink UI.** Mount it through `src/terminal/__testutils__/fakeTerminal.ts`. Do not copy harness code from other tests: some of it is inherited, and the gate below will find it.
   - **Shape.** Prefer a table of cases looped over to a run of near-identical assertions. A run of `expect(f(x)).toBe(y)` lines can match inherited code by shape alone.
   - **Stability.** 3 passing runs in a row.
2. **The probe spec**, at `scripts/migrations/probes/rewrite-levers-<group>.json`. The format is in the header of `scripts/migrations/break-probe.ts`.
   - 3 to 6 probes per file. Each one mutates ONE exact string, which occurs exactly once in its `source`, on a line your tests run.
   - `bun run scripts/migrations/break-probe.ts <spec>` must end with "every probe met its expectation". When a probe stays green, sharpen the tests; never weaken the probe to make it pass.
   - Afterwards, check that the files are unchanged. The runner restores them.

## The gate

`bun run provenance --file <path>...` must report 0 Claude Code and 0
openclaude lines for every file you create. It fingerprints inherited code,
renamed or not, so write everything in your own words and your own shapes.

## Report (under 250 words)

- coverage per file, before and after;
- the test count, and the result of the 3 runs;
- the probe count, and the runner's last line;
- the gate result;
- every line or branch you could not reach without changing production code, and why;
- any defect you found. Pin the current behaviour and name the defect; do not fix it.
