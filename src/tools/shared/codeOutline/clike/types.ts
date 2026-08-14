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
}

export type Candidate = {
  line: number // 0-indexed
  depth: number
  name: string
  kind: SymbolKind
  requiresBody: boolean
}
