// Shared types for the C-like brace-depth engine.

import type { Interpolation } from 'src/tools/shared/codeOutline/mask/core.js'
import type { SymbolKind } from 'src/tools/shared/codeOutline/types.js'

export type CLikeDetection = {
  name: string
  /** Method-ness is derived from kind === 'method' — no separate flag. */
  kind: SymbolKind
  /**
   * Drop the candidate when no brace body opens. True for heuristic method
   * detection (filters TS property / Java field false matches); false for
   * keyword-led detections (Kotlin `fun`, Rust `fn`) where bodyless
   * declarations — expression bodies, trait methods — are legitimate.
   */
  requiresBody: boolean
  /**
   * Verify the line has DECLARATION SHAPE before believing it has a body:
   * from here forward, the body `{` must be reachable at paren depth 0 without
   * crossing a `,` or `;`, and without a `)` that closes a group opened
   * earlier.
   *
   * Set by the loose `ident(` heuristics (TS `RE_METHOD`, the shared Java/C#
   * one), which match a CALL as readily as a declaration. Without it,
   * `resolveCLikeBounds` accepts any later brace as the candidate's body, so
   * `doThing(() => {` becomes a symbol whose range is the callback.
   */
  declShape?: boolean
  /**
   * Require the body `{` on the declaration's OWN line (checked on the masked
   * copy). For a nested landmark the initializer is the body — `const handle =
   * useCallback(() => {`, `const opts = {` — and the brace sits inside the call
   * parens, so the parameter-list scan `declShape` performs does not apply.
   *
   * Without it, `let escaped = false` matched the const pattern and adopted the
   * next block that happened to open: `bashSecurity.ts` reported it as a symbol
   * spanning lines 1264-1504.
   */
  bodyOnOwnLine?: boolean
}

export type CLikeSpec = {
  /**
   * `interp` is threaded per LANGUAGE, not per mask function: Java and Kotlin
   * share `maskJvm` but only Kotlin interpolates.
   */
  mask: (source: string, interp?: Interpolation | null) => string
  /**
   * 'raw' preserves the legacy TS/JS/Go behavior of matching on the raw
   * source line; 'masked' (new languages) means commented-out code never
   * becomes a symbol.
   */
  detectSource: 'raw' | 'masked'
  detect: (trimmed: string, depth: number) => CLikeDetection | null
  /** Symbol kinds whose members are kept as methods. */
  methodContainers: ReadonlySet<SymbolKind>
  /** Kinds transparent for depth gating (C# namespace, Rust mod). */
  namespaceKinds: ReadonlySet<SymbolKind>
  /** Extra line prefixes (besides comments) that count as doc lines. */
  docPrefixes: readonly string[]
  /**
   * Require a kept method to sit exactly one brace level inside its
   * container — filters anonymous-class members (Java/C#) and object
   * expressions (Kotlin). Off for TS/JS to preserve legacy output.
   */
  strictMethodDepth: boolean
  /**
   * Drop any candidate whose line BEGINS inside an unclosed `(` or `[`. Such a
   * line is a continuation of an expression — a call argument, the tail of a
   * multi-line `if (`, a parameter list running onto a second line — where no
   * declaration is syntactically possible.
   *
   * This is not cosmetic. `resolveCLikeBounds` stops a body-requiring
   * candidate at the next candidate's line, so a phantom sitting on a
   * signature's continuation line DELETES the declaration it belongs to:
   * curl's `static size_t populate_settings(nghttp2_settings_entry *iv,` is
   * absent from the symbol table, replaced by a `struct Curl_easy` (its second
   * parameter) whose range covers the function body.
   *
   * Opted into per language so a change here is auditable one language at a
   * time; the languages that carry it are the ones the A/B bench measures.
   * Absent means today's behavior, so a language only changes when its spec
   * says so.
   */
  rejectInsideParens?: boolean
  /**
   * Emit nested declarations as navigation LANDMARKS, size-gated.
   *
   * The outline's line ranges are what `offset/limit` and `Read(symbol=)`
   * navigate by, and a top-level `function` is not a `methodContainer`, so a
   * 2,785-line `export function REPL()` is served as one symbol with no index
   * into it. "Nested declarations are body noise" is right for a 7-line
   * function and wrong for that one; size is what tells them apart, so both
   * ends are measured instead of naming shapes:
   *
   *   minBodyLines    the landmark's own body must be at least this long, so a
   *                   one-line `const x = useAppState(…)` never qualifies and a
   *                   30-line `useCallback` handler does
   *   minParentLines  its enclosing symbol must be at least this long, so small
   *                   functions keep exactly the outline they have today
   *
   * Absent = off, which is every language but TS/JS.
   */
  nestedLandmarks?: { minBodyLines: number; minParentLines: number }
}

export type Candidate = {
  line: number // 0-indexed
  depth: number
  name: string
  kind: SymbolKind
  requiresBody: boolean
  declShape?: boolean
  bodyOnOwnLine?: boolean
}
