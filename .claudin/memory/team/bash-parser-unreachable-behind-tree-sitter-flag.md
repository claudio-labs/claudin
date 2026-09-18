---
name: bash-parser-unreachable-behind-tree-sitter-flag
description: src/platform/bash/bashParser/ is a complete hand-written TS bash parser (~4.5k lines + a 717-line test) that no code path can reach, because its only entry points were gated on the off-map TREE_SITTER_BASH flags; deleting or enabling it is a security-path product decision, NOT dead-code removal
type: project
---

Found 2026-09-18 while removing the folded-false flag clusters
([[dead-code-round-2-2026-09-18]]). **Not taken, deliberately** — recording it so
the next removal pass does not either delete it on a knip signal or re-discover
it from scratch.

The sizes, measured:

| file | lines |
|---|---|
| `bashParser/commands.ts` | 1838 |
| `bashParser/words.ts` | 1192 |
| `bashParser/expressions.ts` | 772 |
| `bashParser/lexer.ts` | 511 |
| `bashParser/parserContext.ts` | 125 |
| `bashParser.ts` | 127 |
| `bashParser/tokens.ts` | 62 — **live** |
| `bashParser.test.ts` (+ snapshot) | 717 |

**Why nothing can reach it.** `parseCommand` and `parseCommandRaw`
(`src/platform/bash/parser.ts`) were the only callers of
`ensureParserInitialized`/`getParserModule`, and both bodies sat inside
`feature('TREE_SITTER_BASH')` / `feature('TREE_SITTER_BASH_SHADOW')`. Neither
flag is in `featureFlags` (`scripts/build/build.ts`), so the build folded both to
`false` and those functions have always returned `null` in every shipped bundle —
which every caller routes to the legacy regex/shell-quote path. Commit 275c7558
removed the gated bodies, so the two functions now return `null` unconditionally
and the parser has no entry point at all.

**Why it still ships.** `src/platform/bash/ast.ts:21` imports `SHELL_KEYWORDS`
from `bashParser.js`, and `bashParser.ts:35` imports `parseStatements` from
`bashParser/commands.js`. One live type-ish import therefore drags the whole
parser into the bundle. `deadcode:ci` cannot see any of this: knip treats a
module imported by its own test as used, which is exactly the gap
`deadcode:prod` (`knip --production`) was proposed to close.

**Why it is a product decision, not rot.** The old gate comment read
*"internal-only until pentest"*, and `PARSE_ABORTED` exists specifically because
collapsing a parse timeout into `null` once routed adversarial input to the
legacy path, which lacks `EVAL_LIKE_BUILTINS` — `trap`, `enable` and `hash`
leaked. So this is a **bash security walker**. Three outcomes, all needing a
human:

1. **Enable it** — put `TREE_SITTER_BASH` in the map. Changes the Bash
   permission path for every user; needs the pentest the comment defers to.
2. **Delete it** — ~4.5k source lines plus the test. Discards a TS port written
   to avoid the NAPI addon.
3. **Leave it** — the status quo: it ships, cannot run, and costs bundle size.

If option 2 is taken: keep `bashParser/tokens.ts` (`SHELL_KEYWORDS` is live via
`ast.ts`) and have `ast.ts` import it directly instead of through `bashParser.ts`.

Same class as [[growthbook-source-dead-stub-is-real]]: a complete, tested
implementation that no shipped path can reach, kept green by tests that import
it directly.
