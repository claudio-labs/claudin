/**
 * Structural compression of JSON tool output.
 *
 * Factors the repeated keys out of a homogeneous array of objects into a
 * compact tab-separated grid (keys declared once, each element a value row
 * prefixed `#N`) and windows long arrays (head/tail + an `<omitted rows="N"/>`
 * marker). Targets a top-level array OR the dominant array-of-objects field of
 * a top-level object (the `gh api` / REST `{ "data": [...] }` shape).
 *
 * Fields whose value is identical on every row are hoisted out of the grid into
 * a single `const={...}` line (the column is then dropped) — lossless, since the
 * full element still lives in the `jsonl` backing.
 *
 * Returns BOTH the compact `render` (goes in the tool-result marker) and a
 * `jsonl` canonical form — one array element per line, aligned 1:1 with the
 * `#N` row index — which the storage layer persists so omitted rows stay
 * retrievable via Read offset/limit or Grep on the cited path.
 *
 * Pure, zero I/O, NO config/ink imports (must stay bun-test-loadable — see the
 * `ink-modules-unimportable-in-tests` note). Never throws: any unexpected
 * shape returns null and the caller passes the output through unchanged.
 */

// Window long arrays: keep HEAD_ROWS from the start + TAIL_ROWS from the end.
const ROW_WINDOW_THRESHOLD = 60
const HEAD_ROWS = 40
const TAIL_ROWS = 10
// Schema-factor only when at least this fraction of elements share one exact
// key signature; otherwise emit JSON-lines (one compact object per line).
const HOMOGENEITY_MIN = 0.8
// Below this the repeated-key savings don't beat the marker overhead.
const MIN_ARRAY_ELEMENTS = 5
// Per-cell width cap; the full value still lives in the persisted jsonl.
const CELL_MAX_WIDTH = 500
// Renders a key that is ABSENT from an object, kept distinct from an
// empty-string value (which renders as an empty cell) and from an explicit
// `null`. The full element always lives in the jsonl, so this is a display aid.
const ABSENT = '∅'

const TAB_NL_RE = /[\t\n\r]/g
const TAB_NL_MAP: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' }

export type JsonCompressResult = {
  /** Compact render for the tool-result marker body. */
  render: string
  /** One array element per line — the retrievable backing, aligned to `#N`. */
  jsonl: string
}

type Target = { array: unknown[]; preamble: string | null }

export function compressJsonArray(text: string): JsonCompressResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  const target = selectTargetArray(parsed)
  if (!target) return null

  const { array, preamble } = target
  if (array.length < MIN_ARRAY_ELEMENTS) return null

  // Only object elements are compressible; bail if the array isn't dominated
  // by objects (e.g. an array of scalars — let head/tail handle that).
  const objectCount = array.reduce<number>(
    (n, el) => n + (isPlainObject(el) ? 1 : 0),
    0,
  )
  if (objectCount / array.length < HOMOGENEITY_MIN) return null

  const jsonl = array.map(el => safeStringify(el)).join('\n')
  const keys = unionKeys(array)
  const hf = homogeneityFraction(array)
  const render =
    hf >= HOMOGENEITY_MIN
      ? renderSchemaFactored(array, keys, preamble, hf < 1)
      : renderJsonLines(array, preamble)

  return { render, jsonl }
}

// ---------- target selection ----------

/**
 * A top-level array → that array. A top-level object → its array-of-objects
 * field with the most object elements (the rest of the object becomes an inline
 * `meta=` preamble). Anything else → null.
 */
function selectTargetArray(parsed: unknown): Target | null {
  if (Array.isArray(parsed)) return { array: parsed, preamble: null }
  if (!isPlainObject(parsed)) return null

  let bestKey: string | null = null
  let bestScore = 0
  for (const [k, v] of Object.entries(parsed)) {
    if (!Array.isArray(v)) continue
    const score = v.reduce<number>((n, el) => n + (isPlainObject(el) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      bestKey = k
    }
  }
  if (bestKey === null || bestScore === 0) return null

  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (k !== bestKey) rest[k] = v
  }
  const preamble = Object.keys(rest).length > 0 ? safeStringify(rest) : null
  return { array: parsed[bestKey] as unknown[], preamble }
}

// ---------- rendering ----------

function renderSchemaFactored(
  array: unknown[],
  keys: string[],
  preamble: string | null,
  showAbsentLegend: boolean,
): string {
  const { constants, varyingKeys } = constantFields(array, keys)
  const hasConstants = Object.keys(constants).length > 0

  const lines: string[] = []
  if (preamble) lines.push(`meta=${preamble}`)
  if (hasConstants) lines.push(`const=${renderConstObject(constants)}`)

  // All-constant: every key is identical across all rows, so the `const=` line
  // fully describes every element — drop the per-row grid (the backing jsonl
  // still holds each element). Guarded on hasConstants so an array of empty
  // objects keeps its normal (empty-keys) grid.
  if (varyingKeys.length === 0 && hasConstants) {
    lines.push(`rows=${array.length} (all identical)`)
    return lines.join('\n')
  }

  lines.push(
    `rows=${array.length} keys=[${varyingKeys.join(',')}]` +
      (showAbsentLegend ? ` (${ABSENT}=absent)` : ''),
  )

  forEachWindowed(array.length, {
    onRow: i => {
      const el = array[i]
      if (isPlainObject(el)) {
        lines.push(`#${i + 1}\t` + varyingKeys.map(k => cell(el[k])).join('\t'))
      } else {
        // Rare non-object element inside a mostly-object array: span one cell.
        // (Its presence disables hoisting, so varyingKeys === keys here.)
        lines.push(`#${i + 1}\t${cell(el)}`)
      }
    },
    onOmit: count => lines.push(`<omitted rows="${count}"/>`),
  })

  return lines.join('\n')
}

/**
 * Compact JSON object for the hoisted-constants line. Each value is truncated
 * to CELL_MAX_WIDTH like a grid cell (the full value stays in the jsonl); no
 * escapeCell — safeStringify already emits JSON, which never carries a raw
 * tab/newline.
 */
function renderConstObject(constants: Record<string, unknown>): string {
  const parts = Object.entries(constants).map(
    ([k, v]) => `${JSON.stringify(k)}:${truncateCell(safeStringify(v))}`,
  )
  return `{${parts.join(',')}}`
}

function renderJsonLines(array: unknown[], preamble: string | null): string {
  const lines: string[] = []
  if (preamble) lines.push(`meta=${preamble}`)
  lines.push(`rows=${array.length} (heterogeneous)`)

  forEachWindowed(array.length, {
    onRow: i => lines.push(`#${i + 1} ${cell(array[i])}`),
    onOmit: count => lines.push(`<omitted rows="${count}"/>`),
  })

  return lines.join('\n')
}

/**
 * Walk indices in head/tail window order, invoking onRow for kept rows and
 * onOmit once for the omitted middle (only when the array exceeds the window).
 */
function forEachWindowed(
  length: number,
  cb: { onRow: (i: number) => void; onOmit: (count: number) => void },
): void {
  if (length <= ROW_WINDOW_THRESHOLD) {
    for (let i = 0; i < length; i++) cb.onRow(i)
    return
  }
  for (let i = 0; i < HEAD_ROWS; i++) cb.onRow(i)
  cb.onOmit(length - HEAD_ROWS - TAIL_ROWS)
  for (let i = length - TAIL_ROWS; i < length; i++) cb.onRow(i)
}

function cell(value: unknown): string {
  if (value === undefined) return ABSENT
  if (value === null) return 'null'
  if (typeof value === 'string') return truncateCell(escapeCell(value))
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return truncateCell(escapeCell(safeStringify(value)))
}

function escapeCell(s: string): string {
  return s.replace(TAB_NL_RE, m => TAB_NL_MAP[m] ?? m)
}

function truncateCell(s: string): string {
  if (s.length <= CELL_MAX_WIDTH) return s
  return s.slice(0, CELL_MAX_WIDTH) + `…[${s.length - CELL_MAX_WIDTH}b]`
}

// ---------- key analysis ----------

/** Keys across all object elements, in first-seen order. */
function unionKeys(array: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const el of array) {
    if (!isPlainObject(el)) continue
    for (const k of Object.keys(el)) {
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

/**
 * Split `keys` into fields that are identical across every element (hoistable)
 * and the rest. A field is constant iff it is an own-property of EVERY element
 * with an equal `safeStringify` value. A single non-object element disables
 * hoisting entirely — a `const={...}` line would not apply to a scalar row.
 * Absent-in-some (∅) columns are never constant, so the present/absent
 * distinction is preserved.
 */
function constantFields(
  array: unknown[],
  keys: string[],
): { constants: Record<string, unknown>; varyingKeys: string[] } {
  for (const el of array) {
    if (!isPlainObject(el)) return { constants: {}, varyingKeys: keys }
  }
  const objects = array as Record<string, unknown>[]
  const constants: Record<string, unknown> = {}
  const varyingKeys: string[] = []
  for (const k of keys) {
    let serialized: string | null = null
    let constant = true
    for (const el of objects) {
      if (!Object.prototype.hasOwnProperty.call(el, k)) {
        constant = false
        break
      }
      const s = safeStringify(el[k])
      if (serialized === null) serialized = s
      else if (s !== serialized) {
        constant = false
        break
      }
    }
    if (constant) constants[k] = objects[0]![k]
    else varyingKeys.push(k)
  }
  return { constants, varyingKeys }
}

/** Fraction of elements sharing the single most common exact key signature. */
function homogeneityFraction(array: unknown[]): number {
  const freq = new Map<string, number>()
  for (const el of array) {
    if (!isPlainObject(el)) continue
    const sig = Object.keys(el).sort().join('\u0000')
    freq.set(sig, (freq.get(sig) ?? 0) + 1)
  }
  let max = 0
  for (const n of freq.values()) if (n > max) max = n
  return array.length === 0 ? 0 : max / array.length
}

// ---------- helpers ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s === undefined ? 'null' : s
  } catch {
    return 'null'
  }
}
