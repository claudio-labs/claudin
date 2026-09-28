# Brief: characterizing a unit

You are writing the regression net and the spec for one unit of the
clean-base rewrite. [The README](../README.md) explains the rewrite; read its
"Definition of done" first. Someone else will later reimplement the unit
without ever seeing the old code. Your tests and your spec are the only bridge,
so everything a caller relies on has to be in one or the other.

## Rules

- Work only inside your sandbox (the directory your brief names). It is a copy of the repository with no git history. Use absolute paths inside it, and run every command with it as the working directory.
- Do not read or write the main checkout (`/home/viudes/projects/claudin`) or the openclaude clone, and run no git command.
- Change nothing but your deliverables and the inherited tests your brief names.
- Run only targeted tests (`bun test <paths>`), because a whole-repo run fails in a sandbox without git. Do not run `bun run build`.
- The shell is shared with other agents. Use absolute paths, and never kill processes by pattern (`pkill -f`, `pgrep | kill`): another agent's run may match. Stop only a process you started, by its PID.

## Deliverables

1. **The characterization suite**, at the path your brief gives. You may split it into several `*.characterization.test.ts(x)` files next to it.
   - **Black box.** Test only through the unit's exports, never private helpers or internal structure. Where a barrel re-exports the unit's names (`src/sessions/sessionStorage.ts`, for one), import them through the barrel.
   - **Real inputs.** Drive the unit the way it runs: real files, directories and processes, and a fresh `mkdtemp` per test. Point `CLAUDIN_CONFIG_DIR`, and every other path or variable the code reads, at temp directories: never the real `~/.claudin`, and never the repository's own `.claudin`.
   - **Git.** Build real repositories in temp directories, and isolate git from the user's configuration: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and `HOME` at a temp directory.
   - **What to pin.** Behaviour, defaults, edge cases, errors, and whatever the callers rely on. To find the callers, grep the sandbox for imports of each file.
   - **Coverage and stability.** At least 70% of the lines of each file of the unit (`bun test <suite> --coverage`), and 3 passing runs in a row.
   - **Mocks.** Mock only at a boundary the code cannot be driven through, such as a model call or the network, following `.claudin/rules/testing.md`.
   - **Shape.** Prefer a table of cases looped over to a run of near-identical assertions. It reads better, and a run of `expect(f(x)).toBe(y)` lines can match the reference by shape alone.
   - **Ink UI.** Mount it through `src/terminal/__testutils__/fakeTerminal.ts`. Do not copy harness code from other tests: some of them are inherited, and the gate will find it.
2. **The spec**, at `docs/tech/rewrite/<unit>.md`, following [spec-template.md](../spec-template.md) (the `skills/*.md` specs are finished examples). Its sections: purpose, public contract (export, signature, used by), observable behaviour, edge cases and errors, security requirements, tests that pin it, out of scope, findings, target design.
   - **Nothing of the old code.** No code, no private names, and no description of the module's internal structure or control flow: only what a caller can observe. Exported names and their signatures are allowed, since they are the contract.
   - **Prompts.** Text the module sends to a model is described by intent: what it must get the model to do, and the exact facts it must state (paths, names, formats, limits), never its sentences. The suite pins those facts with targeted matches, never with whole sentences. List every test, snapshot or generated file outside the unit that pins that text byte for byte, because the rewrite will have to regenerate them.
     - When the same line is rendered in more than one form (a full and a short prompt, say), pin the facts of every form. A fact pinned on one form only can vanish from the others unnoticed.
   - **Formats on disk or on the wire.** Pin them exactly, with small fixture files you create from real inputs under the unit's `__fixtures__/rewrite/` directory.
   - **Decisions.** Every defect you find gets one. "Fix" when no caller, stored data, configuration or user workflow can depend on the old behaviour. Otherwise "keep for parity", with the reason. Describe security findings, and keep them for parity unless the fix is pure hardening that legitimate use never notices.
3. **The probe spec**, at `scripts/migrations/probes/rewrite-<unit slug>.json`. The format is in the header of `scripts/migrations/break-probe.ts`, and `rewrite-bundledSkills.json` is an example.
   - 20 to 40 probes, spread over every file of the unit, each mutating ONE exact string that occurs exactly once in its `source`.
   - **Prove it.** `bun run scripts/migrations/break-probe.ts <spec>` must end with "every probe turned at least one test red". For a probe that stays green, sharpen the tests; never weaken the probe to make it pass.
   - Afterwards, check that the unit's files are unchanged. The runner restores them.
4. **The inherited tests your brief names.** Cover everything they check in your suite, in your own words, then delete them. If one is mostly this project's own, delete only its inherited cases instead; `bun run provenance --file <path>` shows which lines are inherited.

## The gate

`bun run provenance --file <path>...` must report 0 Claude Code and 0
openclaude lines for every file you create. It fingerprints inherited code,
renamed or not, so write everything in your own words and your own shapes.

## Report (under 250 words)

- the test count and the result of the 3 runs;
- coverage per file;
- the probe count, and the runner's last line;
- the gate result;
- each finding, with its decision;
- the files outside the unit that pin prompt text, if any;
- anything you could not pin, and why.
