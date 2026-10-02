# Brief: porting a piece of opencode into a unit

You are replacing one unit's inherited implementation with code adapted from
opencode, under the replacement lever in [levers.md](../levers.md). opencode is
MIT ("Copyright (c) 2025 opencode"), so its code may be copied and changed as
long as its notice travels with it. The unit's old implementation was taken out
of your sandbox on purpose, and it must stay out of your reach: the new code
comes from opencode and from you, never from it.

## Rules

- Work only inside your sandbox (the directory your brief names). It is a copy of the repository with no git history. Use absolute paths inside it, and run every command with it as the working directory.
- You may read `/home/viudes/projects/opencode`, the source of the port. Do not read or write the main checkout (`/home/viudes/projects/claudin`) or the openclaude clone, run no git command, and do not search the web for this code. If you ever see the old implementation, stop and say so in the report.
- **Copy nothing from other modules of this repository.** Many of them are inherited code. Learn from them which APIs exist, but never reproduce their code, their constants or their layout.
- **Keep every exported name in the file that exports it today,** because callers and barrels import from those paths. Grep the sandbox for the importers to learn the contract they use.
- **Change nothing outside the unit,** apart from the new files it needs and its probe spec.
- Run only targeted tests (`bun test <paths>`), because a whole-repo run fails in a sandbox without git. Do not run `bun run build`.
- The shell is shared with other agents. Use absolute paths, and never kill processes by pattern. Stop only a process you started, by its PID.

## Porting

- **Take opencode's code, not its framework.** opencode is built on Effect, its own `@/util/*` helpers and its instance context. Replace those with plain TypeScript, Node APIs and this repository's own primitives (`src/shared/…`). Keep opencode's logic, and whatever of its structure fits.
- **Mark the origin.** Every file holding code adapted from opencode starts with:
  ```ts
  // Adapted from opencode (MIT, Copyright (c) 2025 opencode):
  // packages/opencode/src/<path>
  ```
  Name every opencode file it draws from. A file written wholly by you gets no header.
- **Where opencode has no counterpart** for something the contract needs, write it yourself. Keep that code in its own functions where you can.
- Follow `.claudin/rules/code-design.md` and `.claudin/rules/typescript-patterns.md`: explicit types, no `any`, comments only where they explain why.

## The contract

The unit's characterization suites (`*.characterization.test.ts(x)` next to
its files) are the contract. They pass **unchanged**, with one exception: a
defect your brief lists as "fix". For each one, change only the assertions that
pinned the defect, add a test of the fixed behaviour, and list it in the report.
Every other pinned behaviour stays exactly as it is, defects included.

## Deliverables

1. **The implementation** at the unit's paths.
2. **Unit tests** for whatever the characterization suites do not reach, including each fix.
3. **A probe spec** at `scripts/migrations/probes/rewrite-<unit slug>.json`, written against YOUR code.
   - One probe per behaviour the suites pin, plus the fixes.
   - Its test list names the characterization suites and your new tests.
   - Prove it with `bun run scripts/migrations/break-probe.ts <spec>`: every probe must turn at least one test red.

## Done means

- The characterization suites pass, 3 runs in a row.
- `bun test` over the unit's directories and its callers' directories passes. Report the counts.
- `bunx tsc --noEmit` reports zero errors.
- `bun run provenance --file <path>...` reports 0 Claude Code and 0 openclaude lines for every file you wrote.
- `bun run rewrite:coverage <unit files>`, after a coverage run of the suites, exits 0.

## Report (under 300 words)

- the files you wrote, with line counts, and which opencode files each draws from;
- the exports kept;
- the command results;
- each "fix" applied;
- what opencode had no counterpart for, and what you wrote instead;
- explicit confirmation that you read nothing outside the sandbox and the opencode clone, ran no git, and never saw the old implementation.
