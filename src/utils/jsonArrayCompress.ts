/**
 * Structural compression of JSON tool output.
 *
 * Factors the repeated keys out of a homogeneous array of objects into a
 * compact tab-separated grid (keys declared once, each element a value row
 * prefixed `#N`) and windows long arrays (head/tail + an `<omitted rows="N"/>`
 * marker). Targets a top-level array OR the dominant array-of-objects field of
 * a top-level object (the `gh api` / REST `{ "data": [...] }` shape).
 *
 * Long-array windowing also pins "salient" rows — error-keyword and rare-status
 * rows that would otherwise fall in the blindly-dropped middle — back into the
 * render (see `salientIndices`). Self-gating: no salient rows ⇒ the keep-set is
 * empty and the output is byte-identical to the plain head/tail window.
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

// Salient-row preservation: pin anomaly rows that would otherwise fall in the
// blindly-dropped middle (the failed run / CONFLICT PR / HTTP 500). Self-gating
// — when nothing is salient the keep-set is empty and the render is byte-for-byte
// identical to the plain head/tail window. The full element always lives in the
// jsonl, so pinning only changes which rows render inline, never recoverability.
const ERROR_RE =
  /\b(error|fail(ed|ure)?|fatal|panic|abort(ed)?|denied|reject(ed)?|conflict|critical|blocked|severity|vulnerab|unhealthy|timeout|refused)\b/i
// Cap on pinned middle rows; excess stays in the jsonl and is disclosed in the
// keys header. Priority when capping: error-keyword rows before rare-value rows.
const SALIENT_MAX = 20
// A value seen in fewer than this fraction of rows is "rare" (a salient status).
const RARE_FRACTION = 0.1
// A status-like field has at least 2 and at most this many distinct values.
const LOW_CARD_MAX = 8
// ...and is present on at least this fraction of rows (a sparse field whose
// every value is < RARE_FRACTION would otherwise flag all of them).
const FIELD_PRESENCE_MIN = 0.8

const TAB_NL_RE = /[\t\n\r]/g
const TAB_NL_MAP: Record<string, string> = { '\t': '\\t', '\n': '\\n', '\r': '\\r' }

export type JsonCompressResult = {
  /** Compact render for the tool-result marker body. */
  render: string
  /** One array element per line — the retrievable backing, aligned to `#N`. */
  jsonl: string
  /** Count of anomaly rows pinned out of the dropped middle (0 when none). */
  salientPinned: number
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

  // One stringify pass, reused for the jsonl backing AND the keyword scan.
  const serialized = array.map(el => safeStringify(el))
  const jsonl = serialized.join('\n')
  const keys = unionKeys(array)
  const { constants, varyingKeys } = constantFields(array, keys)
  // salientIndices scans only VARYING fields, so an all-constant array yields an
  // empty keep-set — which keeps salientPinned consistent with the all-identical
  // fast path in renderSchemaFactored (it skips the grid, ignoring `keep`). A
  // future signal that scans constant fields must re-establish that coupling.
  const { keep, omitted } = salientIndices(array, serialized, constants)
  const hf = homogeneityFraction(array)
  const render =
    hf >= HOMOGENEITY_MIN
      ? renderSchemaFactored(array, preamble, hf < 1, constants, varyingKeys, keep, omitted)
      : renderJsonLines(array, preamble, keep, omitted)

  return { render, jsonl, salientPinned: keep.length }
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
  preamble: string | null,
  showAbsentLegend: boolean,
  constants: Record<string, unknown>,
  varyingKeys: string[],
  keep: number[],
  omitted: number,
): string {
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
      (showAbsentLegend ? ` (${ABSENT}=absent)` : '') +
      salientNote(omitted),
  )

  forEachWindowed(array.length, keep, {
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
    onOmit: (first, last) => lines.push(omitLine(first, last, keep.length > 0)),
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

function renderJsonLines(
  array: unknown[],
  preamble: string | null,
  keep: number[],
  omitted: number,
): string {
  const lines: string[] = []
  if (preamble) lines.push(`meta=${preamble}`)
  lines.push(`rows=${array.length} (heterogeneous)` + salientNote(omitted))

  forEachWindowed(array.length, keep, {
    onRow: i => lines.push(`#${i + 1} ${cell(array[i])}`),
    onOmit: (first, last) => lines.push(omitLine(first, last, keep.length > 0)),
  })

  return lines.join('\n')
}

/**
 * Walk indices in head/tail window order. `keep` is a sorted list of salient
 * middle indices (in `[HEAD_ROWS, length-TAIL_ROWS)`) to render in addition to
 * the head/tail; `onOmit(first, last)` fires once per contiguous dropped run.
 * With `keep === []` the middle is a single omitted run — identical to the plain
 * head/tail window.
 */
function forEachWindowed(
  length: number,
  keep: number[],
  cb: { onRow: (i: number) => void; onOmit: (first: number, last: number) => void },
): void {
  if (length <= ROW_WINDOW_THRESHOLD) {
    for (let i = 0; i < length; i++) cb.onRow(i)
    return
  }
  for (let i = 0; i < HEAD_ROWS; i++) cb.onRow(i)
  const midEnd = length - TAIL_ROWS
  let cursor = HEAD_ROWS
  for (const ki of keep) {
    if (ki > cursor) cb.onOmit(cursor, ki - 1)
    cb.onRow(ki)
    cursor = ki + 1
  }
  if (midEnd > cursor) cb.onOmit(cursor, midEnd - 1)
  for (let i = midEnd; i < length; i++) cb.onRow(i)
}

/** Omitted-run marker. Multi-segment (salient) runs carry the `#N` range so the
 * model can Read offset/limit the exact rows; the lone benign run stays bare. */
function omitLine(first: number, last: number, ranged: boolean): string {
  const count = last - first + 1
  return ranged
    ? `<omitted rows="${count}" first="#${first + 1}" last="#${last + 1}"/>`
    : `<omitted rows="${count}"/>`
}

/** Header suffix disclosing salient rows dropped past the cap (empty when none). */
function salientNote(omitted: number): string {
  return omitted > 0 ? ` (+${omitted} salient rows omitted)` : ''
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

// ---------- salient-row detection ----------

/**
 * Indices of "salient" rows — anomalies worth pinning out of the dropped middle
 * — plus a count of any that exceed the cap. Two pure/statistical signals:
 *
 *   - error-keyword: ERROR_RE in any string VALUE (recursing into nested
 *     objects/arrays), over fields that VARY across rows (a keyword identical on
 *     every row is no row-level signal).
 *   - rare value: a string/boolean field present on >= FIELD_PRESENCE_MIN of
 *     rows with 2..LOW_CARD_MAX distinct values, holding a value seen in
 *     < RARE_FRACTION of rows (the lone CONFLICT among OPEN/MERGED).
 *
 * `keep` is SORTED for the windowed walk, restricted to the dropped middle
 * (head/tail render anyway) and capped at SALIENT_MAX (error-keyword first, then
 * rare, then by index). `omitted` counts salient rows dropped past the cap.
 */
function salientIndices(
  array: unknown[],
  serialized: string[],
  constants: Record<string, unknown>,
): { keep: number[]; omitted: number } {
  const length = array.length
  if (length <= ROW_WINDOW_THRESHOLD) return { keep: [], omitted: 0 }
  const midEnd = length - TAIL_ROWS
  const constKeys = new Set(Object.keys(constants))

  // Per-field value frequency over varying string/boolean fields → which fields
  // are status-like and how rare each value is.
  const freq = new Map<string, Map<string, number>>()
  const present = new Map<string, number>()
  for (const el of array) {
    if (!isPlainObject(el)) continue
    for (const [k, v] of Object.entries(el)) {
      if (constKeys.has(k)) continue
      if (typeof v !== 'string' && typeof v !== 'boolean') continue
      // booleans fold to "true"/"false" keys (may collide with literal "true"/
      // "false" strings — harmless: both are low-cardinality status values).
      const val = typeof v === 'boolean' ? String(v) : v
      present.set(k, (present.get(k) ?? 0) + 1)
      let m = freq.get(k)
      if (!m) freq.set(k, (m = new Map()))
      m.set(val, (m.get(val) ?? 0) + 1)
    }
  }
  const statusFields: string[] = []
  for (const [k, m] of freq) {
    if ((present.get(k) ?? 0) / length < FIELD_PRESENCE_MIN) continue
    if (m.size < 2 || m.size > LOW_CARD_MAX) continue
    statusFields.push(k)
  }

  // Ascending and disjoint (keyword short-circuits the rare check per index).
  const keyword: number[] = []
  const rare: number[] = []
  for (let i = HEAD_ROWS; i < midEnd; i++) {
    const el = array[i]
    const kw = isPlainObject(el)
      ? hasKeywordValue(el, constKeys)
      : ERROR_RE.test(serialized[i]!)
    if (kw) {
      keyword.push(i)
    } else if (isPlainObject(el) && isRareRow(el, statusFields, freq, length)) {
      rare.push(i)
    }
  }

  const ordered = keyword.concat(rare)
  const keep = ordered.slice(0, SALIENT_MAX).sort((a, b) => a - b)
  return { keep, omitted: ordered.length - keep.length }
}

/** True if any varying field of `el` carries an error keyword in a string leaf. */
function hasKeywordValue(
  el: Record<string, unknown>,
  constKeys: Set<string>,
): boolean {
  for (const [k, v] of Object.entries(el)) {
    if (constKeys.has(k)) continue
    if (hasKeywordDeep(v)) return true
  }
  return false
}

function hasKeywordDeep(v: unknown): boolean {
  if (typeof v === 'string') return ERROR_RE.test(v)
  if (Array.isArray(v)) return v.some(hasKeywordDeep)
  if (isPlainObject(v)) {
    for (const val of Object.values(v)) if (hasKeywordDeep(val)) return true
  }
  return false
}

/** True if any status-like field of `el` holds a value rarer than RARE_FRACTION. */
function isRareRow(
  el: Record<string, unknown>,
  statusFields: string[],
  freq: Map<string, Map<string, number>>,
  length: number,
): boolean {
  for (const k of statusFields) {
    if (!Object.prototype.hasOwnProperty.call(el, k)) continue
    const v = el[k]
    if (typeof v !== 'string' && typeof v !== 'boolean') continue
    const val = typeof v === 'boolean' ? String(v) : v
    if ((freq.get(k)!.get(val) ?? 0) / length < RARE_FRACTION) return true
  }
  return false
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
