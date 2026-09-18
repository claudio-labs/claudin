import type { TsNode } from 'src/platform/bash/bashParser.js'

export type Node = TsNode

export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

/**
 * The tree-sitter path lived behind the TREE_SITTER_BASH build flag, which is
 * absent from `featureFlags` in scripts/build/build.ts — so this has always
 * returned `null` in every shipped bundle, and every caller already treats
 * that as "parser unavailable, use the legacy regex/shell-quote path".
 *
 * The flag name is spelled out rather than written as a `feature()` call: the
 * ratchet in scripts/build/feature-flags-source-guard.test.ts scans raw source
 * and cannot tell a call from a mention, so the call shape in a comment would
 * hold a removed flag on the off-map list forever.
 */
export async function parseCommand(
  _command: string,
): Promise<ParsedCommandData | null> {
  return null
}

/**
 * SECURITY: Sentinel for "parser was loaded and attempted, but aborted"
 * (timeout / node budget / Rust panic). Distinct from `null` (module not
 * loaded). Adversarial input can trigger abort at modest lengths:
 * `(( a[0][0]... ))` with ~2800 subscripts hits PARSE_TIMEOUT_MICROS.
 * Callers MUST treat this as fail-closed (too-complex), NOT route to legacy.
 */
export const PARSE_ABORTED = Symbol('parse-aborted')

/**
 * Raw parse for the security walker in ast.ts.
 *
 * Was gated on the TREE_SITTER_BASH and TREE_SITTER_BASH_SHADOW build flags,
 * neither of which is in `featureFlags` — so it always returned `null`
 * ("module not loaded"), which callers route to the legacy path. The
 * `PARSE_ABORTED` sentinel above is therefore never produced today; it stays
 * exported because the callers still fail closed on it.
 */
export async function parseCommandRaw(
  _command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  return null
}
