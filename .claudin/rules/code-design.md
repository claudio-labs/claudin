---
paths:
  - "src/**/*.ts"
  - "src/**/*.tsx"
---
# Code Design — Read Before You Modify

How SOLID and Clean Code are actually expressed in this tree, and what to read
before touching a file. The *idioms* (no `any`, zod, `buildTool`, error classes,
path aliases) belong to [typescript-patterns.md](typescript-patterns.md) — this
rule is about structure, seams, and the order of operations.

## 1. Read before you write

In this order, before the first edit:

1. **Outline the target file, don't slurp it.** Most files you will touch are
   500–3000 lines; read the structural outline first, then expand the one symbol
   you are changing. A full read of `REPL.tsx` (3160 lines) to fix one handler is
   the wrong shape.
2. **Read the directory, not just the file.** A `<area>.ts` next to an `<area>/`
   directory is a **barrel** — the logic lives in the siblings
   (`src/tools/shared/codeOutline/`, `src/platform/headless/print/`,
   `src/providers/shims/claude/`). Editing the barrel is almost always wrong.
3. **Grep the callers before changing a signature.** Cross-slice imports use the
   `src/…` alias, so `Grep` on the symbol name finds every call site; there is no
   hidden dynamic wiring except MCP and plugins.
4. **The colocated `*.test.ts` is the spec.** Read it before changing behavior —
   it tells you which of the function's properties are load-bearing.
5. **Check for a `README.md` in the directory** (e.g. `src/agent/cache/README.md`)
   and for a rule scoped to that path — cache, TUI, build and test paths all have
   invariants that no amount of reading the file will reveal.
6. **Before MOVING code, grep the whole repo for the filename.** A few tests read
   production files as *text* and assert on literal call strings; a scoped test run
   stays green while the move breaks them.

## 2. SOLID, as this repo spells it

- **S — Single responsibility** is enforced at the *directory* level, not the
  class level: each slice under `src/` owns one domain and its whole stack.
  A file grows until size × churn hurts, then becomes a barrel plus siblings
  (`scanSymbols.ts` 3911 → a 191-line barrel over 18 modules). Corollary: a big
  file with **no churn** is not a defect — `src/native-ts/yoga-layout/index.ts`
  mirrors upstream on purpose. Split what people edit, not what is merely large.
- **O — Open/closed**: the extension points here are **tables and registries**,
  not conditionals. Add a preset, a `langs/` module, a row in a map. A new
  `if (provider === 'x')` in a hot path is the smell — and `provider !== 'anthropic'`
  wrongly includes bedrock/vertex/foundry, so gate on an explicit set.
- **L — Substitutability**: every provider shim must satisfy the same transport
  contract, so a quirk field that only one backend accepts has to be gated on the
  active transport, never appended unconditionally to the wire body.
- **I — Interface segregation**: pass a **narrow `…Deps` type**, not the world.
  Live examples: `FocusedInputDialogDeps`
  (`src/agent/repl/utils/getFocusedInputDialog.ts:42`), `ResumeSessionDeps`
  (`src/agent/repl/services/resumeSession.ts:76`). Both have a `makeDeps()` in
  their test — that is the payoff.
- **D — Dependency inversion**: depend on the injected `Deps` param or on the
  accessors (`tryGetActiveProvider()`, `getPrimaryModel()`), never on a concrete
  provider or a module singleton reached by a deep import. The DI seam is what
  lets the test run **without `mock.module`** — module mocks leak across files in
  this suite, so an untestable-without-mocks function is a design bug, not a
  testing problem.

## 3. Clean Code, as this repo spells it

- **Match the surrounding code** — its comment density, naming and idiom — over
  any external style guide. Comments say *why*; the code says what.
- **Pure core, thin shell.** Export the decision as a pure function and keep the
  I/O wrapper dumb. This is the single highest-leverage habit here: it is what
  makes a test possible without mocks, and it is how every recent split was done.
- **No bucket names.** `utils/`, `helpers/`, `services/`, `components/` were
  retired; `src/__tests__/moduleBoundaries.test.ts` fails if they return. When no
  slice fits, the answer is a new slice.
- **Prefer relocation over rewrite when splitting.** Move code unchanged and leave
  the existing test file untouched — an untouched suite passing is the only cheap
  proof that a 3900-line move was behavior-preserving.
- **Delete a footgun instead of testing it.** An optional flag that defaults to the
  dangerous behavior should become a second, named function — that removes the
  argument a caller can forget, where a test only records that they can.
- **Scope discipline.** No drive-by refactor inside a feature diff, no abstraction
  invented for one call site, no error handling beyond what was asked. The quality
  pass has its own entry points (`/simplify`, `/code-review`); keep it out of the
  change under review.

## 4. Anti-patterns

| Pattern | Problem | Fix |
|---|---|---|
| Editing a barrel that re-exports siblings | Change lands in the wrong module, or gets lost in the next split | Edit the sibling in `<area>/` |
| Reading a 3k-line file end to end to change one function | Burns context, still misses the invariants | Outline → expand one symbol → read the rule for that path |
| New `if (provider === …)` branch | Breaks the next provider; the tag is not a capability | Table/registry, or an explicit provider set |
| Function only testable via `mock.module` | Mocks leak across files in this suite | Inject a narrow `…Deps` param |
| Splitting a file "because it is big" | Frozen files cost nothing; splits break text-reading tests and the typecheck fingerprints | Rank by size × churn; grep the filename repo-wide first |
| Renaming an export with hand-written edits | Misses call sites among 17k aliased imports | Project-wide rename, then build |
| New `utils.ts` / `helpers.ts` | Reintroduces a retired bucket; boundary test fails | Put it in the slice that owns the behavior |
