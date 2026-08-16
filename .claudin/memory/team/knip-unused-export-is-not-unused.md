---
name: knip-unused-export-is-not-unused
description: acting on knip's "unused exports" list requires three guards it does not give you; four codemod attempts corrupted the tree, and the third guard was learned from a red CI
type: project
---

**"Unused export" means nothing IMPORTS it — not that it is unused.** The
declaring module frequently calls its own export. Deleting on knip's signal
alone removed 1039 live symbols here and produced 956 `TS2304 Cannot find name`.
Of 1307 candidates, 1039 were used locally and only 268 were dead both ways.

Three guards are mandatory before deleting anything from that list:

1. **Referenced inside its own file**, outside its own declaration span. This
   rejects the large majority.
2. **Referenced in any other file at all**, by grep, whatever knip says. This
   fork has 165 unresolved imports, so knip's graph has holes, and from inside
   the report a hole and an unused symbol look identical. See
   [[missing-subsystems-are-not-fixable-by-declaration]].
3. **Read by a code generator rather than by an import.** No import graph shows
   this, so both guards above pass and the symbol still looks dead.
   `scripts/codegen/generate-sdk-types.ts` reads `coreSchemas.ts` as text and turns each
   schema into a public SDK type. Deleting `OutputFormatSchema` and
   `HookJSONOutputSchema` — genuinely imported by nothing — dropped the exported
   `OutputFormat` and `HookJSONOutput` types, 125 to 123. Caught by CI, not
   locally: `bun run verify:sdk-types` gates in `pr-checks.yml` and was missing
   from the pre-PR skill. Before deleting from `src/platform/entrypoints/sdk/`, grep
   `scripts/` for the symbol.

**Regenerating is not the fix when that check goes red.** It always makes the
check pass, because it rewrites the expected output to match whatever the source
now says — so a schema deleted by mistake becomes an accepted, silent removal
from the SDK's public API. Read the regenerated diff: `export type` lines
disappearing means restore the schema.

Three codemod traps, each of which produced a plausible-looking green result:

- **oxc's spans are UTF-16 indices, not UTF-8 bytes.** (`typescript@7` is the Go
  port — `ts.createSourceFile` is gone, the AST moved to `typescript/unstable/ast`,
  so oxc-parser is the practical option.) Slicing a Buffer at oxc offsets
  corrupts every file containing a non-ASCII character, i.e. every file with an
  em-dash in a comment.
- **`/\/\*\*[\s\S]*?\*\/\s*$/` does not match "the JSDoc just above".** Anchored
  at the end, it matches from the FIRST `/**` that can reach it, swallowing
  every declaration in between. One such match rewrote an import specifier into
  `'./relay.oken'`.
- **A hand-rolled brace counter carries no state across lines**, so a multi-line
  template literal, or a `type X =` whose union starts on the next line, ends
  the span early and truncates the declaration.

**Re-parsing each file after the edit is a weak gate**: `'./relay.oken'` parses
fine. `bun run build` is what catches this class. Run it before believing any
codemod over this list.

Barrels are the opposite case and are safe: an unused entry in an
`export { … } from` block genuinely has no importer through that path, and 111
were removed across 11 barrels with no fallout. Generated files
(`coreTypes.generated.ts`) belong in knip's `ignore`, never trimmed by hand —
but note that ignoring the OUTPUT is what leaves the INPUT exposed, which is
guard 3.
