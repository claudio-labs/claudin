/**
 * Empirical probe for ROADMAP #6 (salient-row preservation).
 *
 * Generates the `big-json.sh` fixture in SALIENT mode (rare `state="CONFLICT"`
 * + error-keyword rows buried in the dropped middle) and runs the CURRENT
 * `compressJsonArray` against it to answer one question: does today's blind
 * head/tail window drop the row that matters?
 *
 * Then it measures what #6 would cost to fix it — the marginal inline bytes of
 * pinning the salient rows — versus what it saves: the Read/Grep round-trip the
 * model must pay today to recover them. No production code is changed; the
 * keep-set is computed here as a stand-in for the real implementation.
 *
 *   bun run scripts/profile/json-salient-probe.ts
 */
import { execFileSync } from 'node:child_process'
import { compressJsonArray } from '../../src/utils/jsonArrayCompress.js'

const FIXTURE = `${import.meta.dir}/fixtures/big-json.sh`
const N = 300

function gen(salient: boolean): string {
  return execFileSync('bash', [FIXTURE, String(N), salient ? 'salient' : ''], {
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  }).trim()
}

// Minimal stand-in for #6 salient detection: a row is salient if a value
// carries an error keyword OR holds a rare value of a low-cardinality field.
const ERROR_RE = /\b(error|fail(ed|ure)?|fatal|denied|conflict|vulnerab|unhealthy|timeout|refused)\b/i
const RARE_FRACTION = 0.1 // a value seen in <10% of rows is "rare"

function salientIndices(arr: Record<string, unknown>[]): Set<number> {
  // Per-field value-frequency for low-cardinality string fields.
  const freq: Record<string, Map<string, number>> = {}
  for (const row of arr) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== 'string') continue
      ;(freq[k] ??= new Map()).set(v, (freq[k]!.get(v) ?? 0) + 1)
    }
  }
  const lowCard = new Set(
    Object.keys(freq).filter(k => freq[k]!.size > 1 && freq[k]!.size <= 8),
  )

  const keep = new Set<number>()
  arr.forEach((row, i) => {
    const blob = JSON.stringify(row)
    if (ERROR_RE.test(blob)) return void keep.add(i)
    for (const k of lowCard) {
      const v = row[k]
      if (typeof v === 'string' && freq[k]!.get(v)! / arr.length < RARE_FRACTION) {
        return void keep.add(i)
      }
    }
  })
  return keep
}

function pct(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`
}

// --- 1. default fixture is unchanged (regression guard) -------------------
const plain = gen(false)
const plainOut = compressJsonArray(plain)!
console.log('=== default fixture (no salient) — baseline unchanged ===')
console.log(`  original           ${plain.length.toLocaleString()} B`)
console.log(`  render             ${plainOut.render.length.toLocaleString()} B  (${pct(plainOut.render.length, plain.length)} of original)`)
console.log(`  salient rows       0 (control)\n`)

// --- 2. salient fixture through the CURRENT compressor --------------------
const text = gen(true)
const arr = JSON.parse(text) as Record<string, unknown>[]
const out = compressJsonArray(text)!
const renderLines = out.render.split('\n')
const keptRowLines = renderLines.filter(l => l.startsWith('#'))

const keep = [...salientIndices(arr)].sort((a, b) => a - b)
const HEAD = 40
const TAIL = 10
const droppedZone = (i: number) => i >= HEAD && i < arr.length - TAIL
const salientInMiddle = keep.filter(droppedZone)

// Is any salient row actually visible in today's render?
const visibleSalient = keep.filter(i =>
  out.render.includes(JSON.stringify(arr[i]!.title)) ||
  renderLines.some(l => l.startsWith(`#${i + 1}\t`) && l.includes('CONFLICT')),
)

console.log('=== salient fixture through the CURRENT (blind head/tail) compressor ===')
console.log(`  original           ${text.length.toLocaleString()} B`)
console.log(`  render             ${out.render.length.toLocaleString()} B  (${pct(out.render.length, text.length)} of original)`)
console.log(`  rows total         ${arr.length}`)
console.log(`  salient rows       ${keep.length}  at #${keep.map(i => i + 1).join(', #')}`)
console.log(`  ↳ in dropped mid   ${salientInMiddle.length}  at #${salientInMiddle.map(i => i + 1).join(', #')}`)
console.log(`  ↳ VISIBLE today    ${visibleSalient.length}   ← the bug: ${visibleSalient.length === 0 ? 'every failing row was dropped' : 'some survived'}\n`)

// --- 3. what #6 would cost vs. what it saves ------------------------------
// #6 inline cost: re-add each dropped-middle salient row as one grid line.
// Use a representative existing kept grid-line length (same format) + the row's
// own jsonl length as an upper bound (grid drops keys + hoisted const fields,
// so the real line is smaller — this is conservative against #6).
const repGridLine = keptRowLines.reduce((a, l) => a + l.length + 1, 0) / keptRowLines.length
const jsonlByIndex = out.jsonl.split('\n')
const addedUpperBound = salientInMiddle.reduce((a, i) => a + jsonlByIndex[i]!.length + 1, 0)
const addedRepresentative = Math.round(salientInMiddle.length * repGridLine)
// #6 also fragments the single <omitted> into a few segments (~30 B each).
const extraMarkers = (salientInMiddle.length + 1) * 30

// Read-back cost the model pays TODAY to recover them: a whole extra turn
// (grep tool_use + tool_result echoing the matching rows). Lower bound = the
// salient rows' bytes returned again; the turn overhead is on top.
const readbackBytes = addedUpperBound

console.log('=== #6 cost vs. saving (chars; ~3.5 chars/token) ===')
console.log(`  #6 inline cost     +${(addedRepresentative + extraMarkers).toLocaleString()} B   (grid lines + segmented markers)`)
console.log(`     upper bound     +${(addedUpperBound + extraMarkers).toLocaleString()} B   (if rendered as full jsonl)`)
console.log(`     vs render       ${pct(addedRepresentative + extraMarkers, out.render.length)} bigger render`)
console.log(`     vs original     ${pct(addedRepresentative + extraMarkers, text.length)} of the raw output`)
console.log(`  avoids (≥)         1 Read/Grep round-trip returning ≥${readbackBytes.toLocaleString()} B + a full extra turn`)
console.log(`                     ...only when the model actually needs a dropped salient row.`)
