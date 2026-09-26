---
name: typescript-7-no-classic-compiler-api
description: This repo is on TypeScript 7, whose package exposes only `version` — ts.createSourceFile is gone, so a codemod here has to be lexical or use typescript/unstable
type: project
---

Discovered 2026-09-15 while building `scripts/migrations/strip-analytics/`.

`import ts from 'typescript'` resolves, but the default export carries **only
`version` and `versionMajorMinor`**. `ts.createSourceFile`, `ts.forEachChild`,
`ts.isCallExpression` — the entire classic compiler API — are absent, and
`require('typescript')` gives an object without them too. The failure surfaces
as `undefined is not an object (evaluating 'ts.ScriptTarget.Latest')` at
runtime, not as a type error, so it survives typecheck and dies on first call.

**Why:** the repo runs TypeScript 7 (the native port). Its JS surface is
`typescript/unstable/ast`, `typescript/unstable/ast/is` and
`typescript/unstable/sync`. The AST module has node types and `is` helpers but
**no parse entry point** — parsing goes through `sync`, which wants a Program
and a host, i.e. a real project setup rather than "parse this string".

**How to apply:** before reaching for an AST codemod in this tree, decide
between two honest options.

1. **Lexical, with refusals.** The codename census script (`scripts/verify/`,
   deleted 2026-09-25 — recover it from git history) exported `scanRegions()`,
   which classifies every character as code / comment / string / regex and had
   tests that fail when its quote or regex handling breaks.
   Build on that and make the tool REFUSE anything it cannot place, blocking the
   whole file rather than half-rewriting it. That is what the strip-analytics
   codemod does, and the refusals are where every real bug surfaced.
2. **`typescript/unstable/sync`**, accepting the Program/host setup cost.

If you take option 1, budget for statement-boundary work — it is most of the
difficulty, because semicolons are optional in most of this tree so ASI is the
common case. The five boundary bugs that cost the most there, each now a test:
a `:` ends a `case` label as well as a ternary arm; `.catch(` is a method call
and not a `catch` clause; `n++` terminates while a lone `+` continues; a
statement ending in a string literal ends on a character in the STRING region;
and a comment ending in a period made the call beneath it read as `m.logEvent()`
because the backward scan was not skipping comments.
