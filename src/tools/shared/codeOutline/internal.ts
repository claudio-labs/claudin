// Package-internal helpers shared across the outline scanners.
//
// Nothing here is part of the barrel's public surface — `scanSymbols.ts`
// re-exports none of it. Kept dependency-free so every scanner can reach it
// without pulling in a language module.

/**
 * Reports a scan failure without making this module depend on the logger at
 * import time. `logError` transitively pulls in the provider/analytics chain;
 * the scan-failure path is rare, so a deferred fire-and-forget import keeps
 * scanSymbols a dependency-light leaf usable from scripts and benches.
 */
export function logScanError(e: unknown): void {
  void import('src/utils/log.js')
    .then(m => m.logError(e))
    .catch(() => {})
}

export const MAX_SIGNATURE_CHARS = 160

export const RE_WS_RUN = /\s+/g

/** One open block on an end-keyword scanner's stack (Ruby, Lua). Shared
 *  because both scanners track blocks the same way. */
export type BlockFrame = { entryIndex: number | null }

export function trimSignature(raw: string): string {
  let s = raw.trim()
  const brace = s.indexOf('{')
  if (brace >= 0) s = s.slice(0, brace).trim()
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
  }
  return s
}

/** Trims a raw declaration line to a signature: single-space-collapsed and
 *  length-capped. Optionally cut at the first occurrence of `cut`. */
export function capSignature(raw: string, cut?: string): string {
  let s = raw.replace(RE_WS_RUN, ' ').trim()
  if (cut !== undefined) {
    const idx = s.indexOf(cut)
    if (idx >= 0) s = s.slice(0, idx).trim()
  }
  if (s.length > MAX_SIGNATURE_CHARS) {
    s = s.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
  }
  return s
}

export function leadingIndent(line: string): number {
  let n = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 8 - (n % 8)
    else break
  }
  return n
}

export function nearestEnclosing<T extends { startLine: number; endLine: number }>(
  all: T[],
  target: T,
): T | null {
  let best: T | null = null
  for (const s of all) {
    if (s === target) continue
    if (s.startLine < target.startLine && s.endLine >= target.endLine) {
      if (
        best === null ||
        s.startLine > best.startLine // tighter (closer) container
      ) {
        best = s
      }
    }
  }
  return best
}
