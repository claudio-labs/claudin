// What a transcript line is to the large-transcript loader, decided from its
// first bytes so that ordinary lines are never parsed.

const SNAPSHOT_OPENING = Buffer.from('{"type":"attribution-snapshot"')
const BOUNDARY_MARKER = Buffer.from('"compact_boundary"')
// The marker has to start within this many bytes of its line. Keeps the
// loader from parsing large lines; a boundary laid out with very long members
// ahead of `type` falls outside it.
const BOUNDARY_MARKER_WINDOW = 256

/** Enough of a line to settle its kind: the window, plus a marker starting on its last byte. */
export const LINE_KIND_PREFIX_BYTES = BOUNDARY_MARKER_WINDOW - 1 + BOUNDARY_MARKER.length

export type LineKind = 'snapshot' | 'boundaryCandidate' | 'plain'

/** Classifies a line from its first `LINE_KIND_PREFIX_BYTES` bytes, or all of it when shorter. */
export function lineKind(prefix: Buffer): LineKind {
  if (prefix.subarray(0, SNAPSHOT_OPENING.length).equals(SNAPSHOT_OPENING)) return 'snapshot'
  const marker = prefix.subarray(0, LINE_KIND_PREFIX_BYTES).indexOf(BOUNDARY_MARKER)
  return marker !== -1 && marker < BOUNDARY_MARKER_WINDOW ? 'boundaryCandidate' : 'plain'
}

type BoundaryKind = 'ordinary' | 'preserved'

type BoundaryShape = {
  type?: unknown
  subtype?: unknown
  compactMetadata?: { preservedSegment?: unknown } | null
}

/** The kind of compact boundary a candidate line is, or `undefined` when it is none. */
export function boundaryKindOf(line: Buffer): BoundaryKind | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line.toString('utf8'))
  } catch {
    // A candidate that does not parse is an ordinary line.
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) return undefined
  const { type, subtype, compactMetadata } = entry as BoundaryShape
  if (type !== 'system' || subtype !== 'compact_boundary') return undefined
  return compactMetadata?.preservedSegment ? 'preserved' : 'ordinary'
}
