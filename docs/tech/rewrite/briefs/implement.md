# Brief: implementing a unit

You are writing a new implementation of one unit of the clean-base rewrite,
from its spec and its tests. [The README](../README.md) explains the rewrite.
The previous implementation was taken out of your sandbox on purpose, and it
must stay out of your reach: the point is code written without it.

## Rules

- Work only inside your sandbox (the directory your brief names). It is a copy of the repository with no git history. Use absolute paths inside it, and run every command with it as the working directory.
- Do not read or write the main checkout (`/home/viudes/projects/claudin`) or the openclaude clone. Run no git command, and do not search the web for this code. If you ever see the old implementation, stop and say so in the report.
- **Copy nothing from other modules.** Many of them are inherited code that is scheduled for rewrite too. Learn from them which APIs exist, but never reproduce their code, their constants or their layout.
- **Keep every exported name in the file that exports it today,** because callers and barrels import from those paths. A file may become a thin facade over new modules in a subdirectory named after the concern. Delete a file only if nothing imports it.
- **Change nothing outside the unit,** apart from the new files it needs and its probe spec. If something else has to change (a snapshot that pins prompt text, for instance), change only what the spec lists, and say so in the report.
- Run only targeted tests (`bun test <paths>`), because a whole-repo run fails in a sandbox without git. Do not run `bun run build`.

## Deliverables

1. **The implementation.** Follow `.claudin/rules/code-design.md` and `.claudin/rules/typescript-patterns.md`.
   - Small single-purpose modules, explicit types, and no `any`.
   - Pass dependencies in (a `…Deps` parameter) where the spec's target design asks for it.
   - Comments only where they explain why.
   - Apply every "fix" decision in the spec, and keep every "keep for parity" behaviour exactly.
2. **Unit tests** for whatever the characterization suite does not reach. Every fix decision needs one.
3. **A new probe spec**, at `scripts/migrations/probes/rewrite-<unit slug>.json`, written against YOUR code.
   - One probe per behaviour the characterization suite pins, plus the fixes.
   - Its test list names the characterization suite and your new tests.
   - Prove it with `bun run scripts/migrations/break-probe.ts <spec>`: every probe must turn at least one test red.

## Done means

- The characterization suite passes unchanged, 3 runs in a row.
- `bun test` over the unit's directories and its callers' directories passes. Report the counts. If a failure also happens without your change, show that it is unrelated.
- `bunx tsc --noEmit` reports zero errors.

## Report (under 300 words)

- the files you wrote, with line counts;
- the exports kept;
- the command results;
- how each decision in the spec was applied;
- deviations from the spec, and why;
- explicit confirmation that you read nothing outside the sandbox, ran no git, and never saw the old implementation.
