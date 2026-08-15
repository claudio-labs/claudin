---
name: outline-blind-to-nested-members
description: Measured 2026-08-12 — scanSymbols emits only top-level declarations and class methods, so it hides MORE than it shows (26,336 nested/object-literal members vs 23,452 emitted, 72.6% of files), which silently degrades the default auto-outline Read path
type: project
---

Census of 528 transcripts / 280 sessions plus a scan of all 3,057 TS/TSX files in
`src/`. This is the root defect behind "symbol search is weak"
([[search-stack-measured]]) — and it is not a search problem, it is a **Read** problem.

**CORRECTION — the "112% hidden" figure was wrong.** A prototype (below) showed the
regex I used to count "hidden members" was over-inclusive: it counted every
`const x =` at any depth, so most of the 26,336 were **local variable bindings and
React hook calls** (`const tasks = useAppState(…)`), which nobody wants in an
outline. `src/terminal/prompt-input/PromptInput.tsx` has 139 such 2-space `const`
bindings — that is the bulk of its "157 hidden". The repo's "body noise" policy is
correct and deliberately tested. The genuine hidden API surface is **~1,030 symbols
(+5%)**, not 26,336, and it is almost entirely one shape: object-literal members.

**The real blind spot.** `scanSymbols` emits at `depth === 0` plus class methods
(`detectTsJs:1617-1644`), and `scanCLike:2215-2222` drops any method whose nearest
enclosing symbol is not in `methodContainers` — which for TS is
`new Set(['class'])` (`:1882`). So in `export const XTool = buildTool({ call() {} })`
the parent is a `const` and every member is discarded. Verified examples:

- `src/tools/GrepTool/GrepTool.ts` — 827 lines → **13 symbols**, and `GrepTool`
  itself is one `const` spanning 224-827. `call`, `validateInput`, `isEnabled` are
  all absent. Every tool in this repo is `export const XTool = buildTool({…})`, so
  this is the shape of `src/tools/` entirely.
- `src/terminal/prompt-input/PromptInput.tsx` — 2,566 lines → **5 symbols**,
  157 members hidden.

**Why it bites by default.** `AUTO_OUTLINE_ON_ELISION` replaces a full-body Read at
≥10,000 chars or ≥250 lines, gated only by `READ_AUTO_OUTLINE_MIN_SYMBOLS = 3`
(`FileReadTool.ts:1450-1461`). Five symbols clears a gate of three, so a 2,566-line
file is served as five signatures and the model has no way to know what it lost.
The gate was written to protect a long single-function file; it does not protect a
file whose members are merely invisible. A density test (symbols per line) would.

**What the census killed.** Both are dead ends — do not re-propose without new data:
- *A scanSymbols cache.* The cache it would duplicate already exists one layer up:
  `Read` is in the tool-result cache whitelist at a 60 s TTL with an `isFreshOnDisk`
  check (`src/agent/tools/toolResultCache.ts:41,92-95`), so a repeat on an
  unchanged file never reaches the scanner. Measured properly — counting the
  **auto-pivot** path, not just explicit `view:"outline"` — there are 675
  scan-triggering Reads of big code files; 174 repeat a file in-session, 145 with the
  file unmodified, and only **37 (5.5%)** fall outside the 60 s TTL. At ~2 ms per
  single-file scan that is ~74 ms across 280 sessions. Grep `output_mode:"symbols"`
  (50 files/call, the only place the 188 ms figure applies) was used **6** times in
  1,901 Grep calls; `Rename` **4** times.
- *LSPTool as the surface for a definition lookup.* **0** LSP calls ever recorded,
  and it is `shouldDefer: true` — behind ToolSearch, so the model never sees it.
  Reach a definition feature through Grep (1,901 calls) or Read (4,597), not there.

**The demand is real, though.** Of 1,901 Grep calls: **16.7%** carry a
definition-shaped pattern (`export function X`, `const X =`) and **16.9%** are a bare
identifier — 33.6% combined, and **256** of them are immediately followed by a Read.
That is the grep→read→infer loop, ~0.9 times per session.

**PROTOTYPE VALIDATED 2026-08-12 — the fix is ~8 lines, and it is additive.**
Built in `/tmp/proto` (regenerable: copy the module, it is dependency-free apart from
one deferred dynamic import). Variant **A** = add `'const'` to `TS_METHOD_CONTAINERS`
plus one regex for `key: () =>` / `key: function` wired into the `depth >= 1` branch
of `detectTsJs`. Measured over 2,489 files / 20.7 MB:

- **180/180 of the existing `scanSymbols.test.ts` pass unmodified.** Purely additive.
- +1,030 symbols (+5%), outline bytes **+3.4%**, throughput 18.6 → 18.0 KB/ms (−3%).
- Only **192 of 2,489 files change (7.7%)** — and the gains land exactly where the
  census said: `FileEditTool` 3→26, `GlobTool` 7→23, `GrepTool` 13→33, `FileWriteTool`
  7→29. `FileEditTool.ts` was serving **3 symbols for 697 lines**, one over the
  auto-pivot's `MIN_SYMBOLS = 3` gate.
- **No flooding.** The densest files (`outputFilter/Bash/filters/*`, generated types,
  77-125 symbols) are completely unchanged by A — `requiresBody: true` keeps data
  properties out. The new names are the tool interface, 51 tools deep:
  `description×51 call×50 prompt×49 inputSchema×49 validateInput×26`.

**Variant B (also emit nested function/class declarations) is REJECTED:** it fails
`scanSymbols.test.ts:227`, a test that deliberately pins "inner/local/LocalClass are
body noise". That is a design decision, so B needs a product argument, not a bug one.

**Two things A does NOT fix — do not claim it does.**
1. *The definition lookup barely moves: 25/60 → **26/60**.* Reading what stays
   unresolved explains why and kills my earlier claim that the scanner was the cause:
   `claudindev`, `kimi`, `tokyo`, `CLAUDIN_CONFIG_DIR`, `stdout`, `effort`, `strict`
   are env vars, string literals, tool names and prose — **there is no definition to
   find**. Bare-identifier Grep is mostly not a definition lookup.
2. *Thin outlines on big files stay thin:* of 698 files ≥250 lines, those served ≤8
   symbols go 203 → 199. The residue is React components whose members are
   hook-bound `const` arrows — i.e. the "body noise" case, by design.

**How to apply:** land A (small, additive, tested). Then make the auto-outline gate
density-aware — `MIN_SYMBOLS = 3` is what let a 697-line file through as 3 lines.
Treat a definition-lookup feature as unjustified until someone re-measures demand
against symbols that actually exist.
