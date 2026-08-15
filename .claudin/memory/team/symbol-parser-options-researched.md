---
name: symbol-parser-options-researched
description: Researched 2026-08-12 — options for replacing the regex symbol scanner; tree-sitter IS shippable in a Bun --compile binary and its upstream tags.scm already solves our object-literal blind spot, but the blocker is the SYNC call in toolResultSummarizer, not size
type: project
---

Web research plus a local constraint audit, done to decide how to fix
[[outline-blind-to-nested-members]]. Recorded because it is expensive to re-derive.

**The size objection is dead — check the numbers before repeating it.** The compiled
binary is *already* **224 MB** (`dist/bin/linux-x64/claudin`, plus a 25 MB `vendor/`),
and there is **no size assertion, budget, or CI gate anywhere** — `scripts/build.ts:698`
only prints the MB. web-tree-sitter's runtime is 355 KB; a size-optimized
`@vscode/tree-sitter-wasm` TypeScript grammar is 1.43 MB and JavaScript 385 KB. TS+TSX+JS
is under 2% of the binary. The 22 MB figure only applies if you embed ~20 grammars
eagerly, which we would not.

**The real blocker is synchronicity.** `summarizeCodeOutline`
(`src/agent/tools/toolResultSummarizer.ts:499-527`) calls `scanSymbols` **inline and
synchronously**, and it is reached from `maybeSummarizeToolResult` → `toolResultStorage.ts:267,285`
— i.e. on **every tool result**, not just file tools. web-tree-sitter's `Parser.init()`
and `Language.load()` are async. A swap means either making that whole path async or
pre-warming a synchronous singleton at startup. Decide that before anything else.

**Bun `--compile` does embed `.wasm`** via `import p from "./g.wasm" with { type: "file" }`
(`/$bunfs/` path, readable through `Bun.file`/`fs`). Two traps: `scripts/build.ts` has
**no `.wasm` loader** today (`.md`/`.txt` are inlined as JS string literals at
`build.ts:472-506`, which a binary asset cannot ride), and the known failure mode in the
wild is **Web Workers**, not WASM — opentui/opencode's tree-sitter silently degraded
under brew install because `--compile` does not auto-bundle worker entrypoints
(opentui#807). Parse on the main thread and that class of bug disappears. The
vendor-beside-`execPath` pattern already exists and is proven (`src/shared/fs/ripgrep.ts:109-120`,
`scripts/vendor-sharp.ts`, gated in `scripts/assemble-packages.ts:103-137`).

**Upstream tags.scm already fixes our exact blind spot.** Both tree-sitter-javascript's
and aider's `javascript-tags.scm` carry:
`(pair key: (property_identifier) @name value: [(arrow_function) (function_expression)]) @definition.function`
— so `{ call: () => {} }` is a definition, and the `method_definition` pattern is
unanchored so `build({ call() {} })` matches too. **Even if we never take the
dependency, that query file is the enumeration of shapes our regex scanner should
emit.** Copy the shape list, not necessarily the parser.

**What everyone else does — there is no consensus, so don't cite one.** opencode: LSP
only, auto-installs 40+ servers. Cline/Roo: tree-sitter only (and Roo's caller is
non-recursive, top-50-files — the naive *traversal* loses symbols, not the query).
Continue.dev: tree-sitter chunking + embeddings in LanceDB. Cursor: embeddings only,
server-side, tree-sitter for chunking. aider: tree-sitter tags + a graph rank (its docs
say "a graph ranking algorithm"; PageRank appears only in secondary sources).

**Two evidence points that back our own rejections:** aider has **never published an
evaluation** of whether its repo map helps, despite benchmarking everything else — so
[[repo-map-rejected-orientation-measured]] is not contradicted by their shipping it.
And Anthropic **removed** the RAG/embedding index from Claude Code in May 2025, saying
agentic grep/glob/read "outperformed everything, by a lot" (staleness, fuzzy false
positives, index upkeep) — relayed via secondary write-ups, not a first-party changelog.

**Options, in the order they should be considered:**
1. **Extend the regex scanner** to emit object-literal members and nested declarations.
   Sync, zero deps, zero bytes, no async collision, and it targets the measured defect
   exactly. Use tags.scm as the shape checklist.
2. **web-tree-sitter for TS/JS only**, lazily loaded, regex retained for the long tail.
   ~1.8 MB. Gate on solving the sync boundary and on a real parse benchmark —
   **throughput and init cost are UNMEASURED**; the one qualitative source says WASM is
   "small enough that most users won't notice" while also saying native would be faster.
   Current regex baseline is ~22 KB/ms.
3. **universal-ctags subprocess** (`--output-format=json --fields=+neKzS`). Fits the
   vendored-binary pattern, ~2 MB, emits `scope`/`scopeKind`. **Rejected for now:** no
   confirmation it handles TS/JS object-literal members, and it adds a per-platform
   binary to build, sign and gate in `assemble-packages.ts`.
