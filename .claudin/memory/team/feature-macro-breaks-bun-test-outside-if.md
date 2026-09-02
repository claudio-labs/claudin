---
name: feature() outside an if/ternary breaks bun-test module loading
description: A bun:bundle feature('FLAG') macro used in && / || / assignment / return throws "can only be used directly in an if statement or ternary condition" when that module is imported under `bun test`, blocking the whole test file from loading
type: feedback
---

`feature('FLAG')` (the `bun:bundle` macro) MUST appear **directly** in an `if`
condition or a ternary. Any other position — `feature('X') && cond`,
`feature('X') || feature('Y')`, `const t = feature('X')`, `return feature('X')` —
throws at load under `bun test`: *"feature() from bun:bundle can only be used
directly in an if statement or ternary condition"*, which fails the ENTIRE test
file (0 pass / 1 error) for any test whose import graph reaches that module.

**Why:** `scripts/build.ts` preprocesses `feature('X')` into a boolean literal at
build time regardless of position, so the **build never catches this** — only
`bun test` (no preprocessing, native bun macro) does. A 2026-06-29 example: #92's
`isLoopTriggerEnabled` (`extractMemories.ts:90`) used `feature('LOOP_ERROR_MEMORY_TRIGGER') && …`,
silently breaking `toolResultSummarizer.integration.test.ts` +
`toolResultJsonCompression.cacheSafety.test.ts` (both import the tool-result graph
that reaches extractMemories). Fixed by `if (!feature('FLAG')) return false`.

**How to apply:** when gating with `feature()`, write
`if (!feature('FLAG')) return false` / `const x = feature('FLAG') ? a : b`, never a
`&&`/`||`/assignment form. Note: `src/tools.ts`, `src/query.ts`, `src/commands.ts`
already have many `feature('X') && …` / `const X = feature('Y')` forms — those
modules are simply never imported under bun test, so they don't surface it; if a
new test ever pulls them in, expect this same load error. After adding a
`feature()` gate to a module that any test imports (directly or transitively),
run that test file under `bun test` to confirm it still loads.
