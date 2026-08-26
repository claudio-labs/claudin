---
name: outline-blind-to-nested-members
description: The outline scanner's two measured defects and their fixes — phantom symbols that DELETE the declaration they sit on (840 across the bench corpus), and container blindness on top-level `function` bodies; both closed on branch feat/outline-landmarks, 2026-08-26
type: project
---

Two rounds of work on `scanSymbols`, both measured. Round 1 (2026-08-12) found
the recall side; round 2 (2026-08-26) found a precision defect that was worse,
and closed both. The A/B harness that produced every number below is
`scripts/bench/ab/outline-symbols-ab.ts` over a pinned 964-file, 12-language
corpus (`scripts/bench/corpus/`, cached in `~/.cache/claudin-bench-corpus/`).

## Round 1 — recall (LANDED)

Variant A landed: `TS_METHOD_CONTAINERS` is `{class, const}`, so
`export const XTool = buildTool({…})` emits its members. `GrepTool.ts` went
13 → 33 symbols. **Variant B (emit all nested declarations) stayed rejected** —
it fails `scanSymbols.test.ts:213`, which pins "inner/local/LocalClass are body
noise".

Two claims from round 1 that the census killed are still dead: a `scanSymbols`
cache (the tool-result cache already covers it — only 5.5% of scans fall outside
the 60 s TTL) and LSPTool as a definition-lookup surface (0 calls ever, and it
is `shouldDefer`).

## Round 2 — the precision defect nobody was looking for

`RE_METHOD` (`clike/detectors.ts`) matches any line starting `ident(`, and
`resolveCLikeBounds` accepted **any later brace** as that candidate's body. So a
call argument, or the continuation line of a multi-line expression, became a
symbol whose range is the next unrelated block.

The part that makes it more than noise: a body-requiring candidate **stops at
the next candidate's line**, so a phantom sitting on a signature's continuation
line DELETES the declaration it belongs to. In curl's `http2.c`,
`static size_t populate_settings(nghttp2_settings_entry *iv,` was **absent**
from the symbol table, replaced by a `struct Curl_easy` (its own second
parameter) whose range covered the function body. 840 phantoms across 79 of 152
sampled curl files; 18 in `src/`.

Fixes, all in `clike/`:

- `CLikeSpec.rejectInsideParens` — drop a candidate whose line BEGINS while the
  innermost unclosed group is `(` or `[`. On for TS/JS, Java, C#, C.
- `CLikeDetection.declShape` — for the loose `ident(` detectors, verify the body
  `{` is reachable: parens must close, no `)` underflow, no `;`, and the brace
  within 2 lines of the close. Set on TS `RE_METHOD`, `detectJavaCsMethod`,
  `detectC`.
- `CLikeDetection.bodyOnOwnLine` — a landmark's body is its initializer, so the
  `{` must be on its own line. Without it `let escaped = false` adopted the next
  block (240 lines in `bashSecurity.ts`).
- `CLikeSpec.nestedLandmarks` `{minBodyLines: 20, minParentLines: 100}` on TS
  only — the size-gated version of variant B, which is the product argument B
  lacked.

**Result:** corpus symbols −1.4%, outline bytes **+0.6%**; `REPL.tsx` 25 → 56
**Result:** corpus symbols −1.6%, outline bytes **+3.7%**; `REPL.tsx` 25 → 56
symbols, `PromptInput.tsx` 6 → 25, and curl's real functions come back. The
scanner alone was +0.6% — the rest is the Read-layer coverage line below.

## Round 2, Read layer

Four changes ship with the scanner, all in `FileReadTool`/`renderOutline`:

- A coverage line in the outline header (`N symbols covering X% of the lines;
  the largest spans Y%`), so a thin outline announces itself instead of reading
  as a complete table.
- `symbol=` on a symbol too large to inline returns **that symbol's outline**,
  with `view: 'full'` named as the way out. It used to return the whole body.
- Outline truncation drops the DEEPEST entries first, so an over-cap file loses
  nested members before top-level declarations.
- The auto-outline pivot is density-aware: a long file whose symbols cover
  almost none of it gets the body, not a table of three names.

## Traps this round paid for — do not re-learn them

- **A group-stack rule needs a fail-open.** A backtick inside a regex character
  class starts a phantom template literal in the mask and blanks the rest of the
  file (axios `AxiosHeaders.js:32`), leaving brackets unmatched. Without
  `groupsBalanced`, `rejectInsideParens` dropped all 33 real declarations there.
  Same contract as the existing `depth !== 0` brace check.
- **TS/JS detect on the RAW line** (`detectSource: 'raw'`), and `RE_METHOD`
  tolerates a leading `*` — so a doc comment saying `forceRedraw()` matched,
  reached forward, adopted the NEXT method's body, and then filtered that real
  method out for having a phantom parent. The masked line having no `(` is what
  tells a comment from code.
- **A comma is not a statement terminator in a declaration tail.** Treating one
  at paren depth 0 as the end cost six real `JObject` members in
  Newtonsoft.Json and every `throws A, B {` in Gson.
- **Re-arming the body-search gap on every later `)` lets a RUN of call
  statements chain** until something opens a brace; those phantoms are filtered
  later but linger long enough to be found as a landmark's enclosing symbol.
  Measure the gap from the FIRST close.
- **Filter methods BEFORE landmarks.** A landmark's enclosing symbol must be one
  that survives, or a discarded method between it and the real container is
  measured as its parent.
- **A header note is not free on a small outline.** The coverage line is ~80
  bytes; on a 339-byte JavaScript outline that is +20%, which failed the byte
  criterion on its own. It is emitted only for files ≥200 lines or where the
  largest symbol spans ≥50% — the shape it exists to flag.

## The bench's own lesson

The fix and the phantom detector converge on the same signal, so
"the rule finds nothing" would pass by construction. Criterion 1 is therefore
stated over a **hand-verified witness list** (`PHANTOM_WITNESSES`) with three
parts — bogus symbols that must vanish, real ones that must survive, real ones
the fix must RESTORE — not over the detector's count, which is reported as an
observation. Removals are explained by two independent tests plus a
hand-triaged allowlist; anything left over fails the run with `file:line`.

Also: compare bytes **per file against its own baseline**, not as a ratio of two
cells' medians — the latter read +43% where the typical file grew 28%. And the
baseline must be recorded on unmodified HEAD; a `git worktree` at the exact SHA
is the non-destructive way (no stash, per `.claudin/rules/agent-safety.md`).

And this repo **is** the TypeScript corpus, with the sample drawn per size
bucket — so editing the scanner moves its own files across bucket boundaries and
resamples the corpus. Every comparison is per file against its own baseline row
and skips a label the baseline lacks, which keeps it apples-to-apples; the
corpus totals just cover slightly fewer files than the run reports.

## Still open

- **33 C phantoms survive**, all in six curl files whose masked copy has
  unbalanced brackets (`multi.c`, `url.c`, `openssl.c`, `gtls.c`, `mbedtls.c`,
  `sectransp.c`), where `rejectInsideParens` fails open by design. The root
  cause is the mask, not the gate — same class as
  [[outline-mask-desync-zero-symbols]].
- **Kotlin has ~50 phantoms** the gate does not reach — its detector was left
  out of scope deliberately. Java and C# showed **zero** in this corpus, so
  their opt-in is correctness insurance, not a measured win.
- JavaScript coverage is the weakest cell by far: express/axios files median
  **1-3 symbols and 5-7% line coverage**, because CommonJS `module.exports = {}`
  and `exports.foo = function` match nothing. Untouched by this round.
