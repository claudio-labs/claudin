import { describe, expect, test } from 'bun:test'
import { compressJsonArray } from './jsonArrayCompress.js'

const mkRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    title: `item ${i + 1}`,
    state: i % 2 === 0 ? 'OPEN' : 'MERGED',
  }))

describe('compressJsonArray', () => {
  test('top-level homogeneous array → schema-factor grid', () => {
    const out = compressJsonArray(JSON.stringify(mkRows(6)))
    expect(out).not.toBeNull()
    const { render, jsonl } = out!
    expect(render).toContain('rows=6 keys=[number,title,state]')
    expect(render).toContain('#1\t1\titem 1\tOPEN')
    expect(render).toContain('#6\t6\titem 6\tMERGED')
    // jsonl: one element per line, aligned 1:1 with #N
    expect(jsonl.split('\n')).toHaveLength(6)
    expect(jsonl.split('\n')[0]).toBe(JSON.stringify(mkRows(6)[0]))
  })

  test('object-wrapped array (REST shape) → meta preamble + compressed array', () => {
    const payload = { total_count: 2, workflow_runs: mkRows(5) }
    const out = compressJsonArray(JSON.stringify(payload))
    expect(out).not.toBeNull()
    expect(out!.render).toContain('meta=')
    expect(out!.render).toContain('"total_count":2')
    expect(out!.render).toContain('rows=5 keys=[number,title,state]')
    // jsonl is the inner array, not the wrapper
    expect(out!.jsonl.split('\n')).toHaveLength(5)
  })

  test('key union: absent minority key renders the ∅ sentinel + legend', () => {
    // 9/10 share {id,name,draft} (≥80% homogeneity → schema-factor); #2 omits draft.
    const rows = Array.from({ length: 10 }, (_, i) =>
      i === 1
        ? { id: i + 1, name: 'b' }
        : { id: i + 1, name: `n${i + 1}`, draft: i % 2 === 0 },
    )
    const out = compressJsonArray(JSON.stringify(rows))
    expect(out).not.toBeNull()
    expect(out!.render).toContain('keys=[id,name,draft]')
    // not homogeneous → the legend declares the sentinel once
    expect(out!.render).toContain('(∅=absent)')
    // #2 has no draft → ∅ cell (distinct from an empty-string value)
    const line2 = out!.render.split('\n').find(l => l.startsWith('#2\t'))!
    expect(line2).toBe('#2\t2\tb\t∅')
  })

  test('absent key vs empty-string vs null are distinguishable in the grid', () => {
    // All share {a,b}; vary b: present-empty, explicit null, and (#3) absent.
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: '' }, // empty-string value → empty cell
      { a: 3 }, // absent → ∅
      { a: 4, b: null }, // explicit null → null
      { a: 5, b: 'y' },
    ]
    const out = compressJsonArray(JSON.stringify(rows))!
    const byId = (n: number) =>
      out.render.split('\n').find(l => l.startsWith(`#${n}\t`))!
    expect(byId(2)).toBe('#2\t2\t') // empty-string → empty cell
    expect(byId(3)).toBe('#3\t3\t∅') // absent → sentinel
    expect(byId(4)).toBe('#4\t4\tnull') // explicit null → literal
  })

  test('perfectly homogeneous grid omits the absent legend', () => {
    const out = compressJsonArray(JSON.stringify(mkRows(6)))!
    expect(out.render).not.toContain('(∅=absent)')
  })

  test('<80% homogeneous → JSON-lines fallback', () => {
    const rows = [
      { a: 1 },
      { b: 2 },
      { c: 3 },
      { d: 4 },
      { e: 5 },
    ]
    const out = compressJsonArray(JSON.stringify(rows))
    expect(out).not.toBeNull()
    expect(out!.render).toContain('(heterogeneous)')
    expect(out!.render).toContain('#1 {"a":1}')
  })

  test('nested object/array value rendered as compact JSON in its cell', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      labels: ['x', 'y'],
      meta: { k: i },
    }))
    const out = compressJsonArray(JSON.stringify(rows))
    expect(out!.render).toContain('["x","y"]')
    expect(out!.render).toContain('{"k":0}')
  })

  test('tab/newline in a string value are escaped, grid stays parseable', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      body: `line1\nline2\tcol`,
    }))
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).toContain('line1\\nline2\\tcol')
    // no raw newline inside a row beyond the line separators
    const rowLines = out.render.split('\n').filter(l => l.startsWith('#'))
    expect(rowLines).toHaveLength(5)
  })

  test('long array → head/tail window with omitted marker, full jsonl', () => {
    const out = compressJsonArray(JSON.stringify(mkRows(100)))!
    expect(out.render).toContain('<omitted rows="50"/>')
    expect(out.render).toContain('#1\t')
    expect(out.render).toContain('#100\t')
    expect(out.render).toContain('#40\t')
    expect(out.render).toContain('#91\t')
    expect(out.render).not.toContain('#41\t')
    expect(out.render).not.toContain('#90\t')
    // backing keeps every element
    expect(out.jsonl.split('\n')).toHaveLength(100)
  })

  test('non-array / scalar elements / too-small / unparseable → null', () => {
    expect(compressJsonArray('not json')).toBeNull()
    expect(compressJsonArray(JSON.stringify({ a: 1, b: 2 }))).toBeNull()
    expect(compressJsonArray(JSON.stringify([1, 2, 3, 4, 5]))).toBeNull()
    expect(compressJsonArray(JSON.stringify(mkRows(4)))).toBeNull() // < MIN
    expect(compressJsonArray(JSON.stringify('a string'))).toBeNull()
  })
})

describe('compressJsonArray — constant-field hoisting', () => {
  test('a field identical on all rows is hoisted to const= and dropped from the grid', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      number: i + 1,
      title: `item ${i + 1}`,
      author: 'dev',
    }))
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).toContain('const={"author":"dev"}')
    // dropped from the keys header AND each row (it lives only on the const= line)
    expect(out.render).toContain('rows=6 keys=[number,title]')
    const line1 = out.render.split('\n').find(l => l.startsWith('#1\t'))!
    expect(line1).toBe('#1\t1\titem 1')
    // lossless: the backing jsonl still carries author on every line
    const jl = out.jsonl.split('\n')
    expect(jl).toHaveLength(6)
    expect(jl.every(l => l.includes('"author":"dev"'))).toBe(true)
  })

  test('a varying field is NOT hoisted (no const= line)', () => {
    const out = compressJsonArray(JSON.stringify(mkRows(6)))!
    expect(out.render).not.toContain('const=')
    expect(out.render).toContain('keys=[number,title,state]')
  })

  test('an absent-in-some column is never hoisted even with equal present values', () => {
    // 5/6 share {id,name,tag} (≥80% → schema-factor); #3 omits tag.
    const rows = Array.from({ length: 6 }, (_, i) =>
      i === 2
        ? { id: i, name: `n${i}` }
        : { id: i, name: `n${i}`, tag: 'same' },
    )
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).not.toContain('const=')
    expect(out.render).toContain('keys=[id,name,tag]')
    expect(out.render).toContain('(∅=absent)')
  })

  test('an array-valued constant is hoisted', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      labels: ['area/cache', 'type/perf'],
    }))
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).toContain('const={"labels":["area/cache","type/perf"]}')
    expect(out.render).toContain('keys=[id]')
  })

  test('wrapper meta= and hoisted const= are distinct lines', () => {
    const payload = {
      total_count: 6,
      items: Array.from({ length: 6 }, (_, i) => ({
        number: i + 1,
        author: 'dev',
      })),
    }
    const out = compressJsonArray(JSON.stringify(payload))!
    expect(out.render).toContain('meta={"total_count":6}')
    expect(out.render).toContain('const={"author":"dev"}')
    expect(out.render).toContain('keys=[number]')
  })

  test('all-constant rows → const= + rows=N (all identical), no #N lines, full jsonl', () => {
    const rows = Array.from({ length: 70 }, () => ({
      kind: 'pod',
      status: 'Running',
    }))
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).toContain('const={"kind":"pod","status":"Running"}')
    expect(out.render).toContain('rows=70 (all identical)')
    expect(out.render).not.toContain('#1')
    expect(out.render).not.toContain('<omitted')
    // backing keeps every element
    expect(out.jsonl.split('\n')).toHaveLength(70)
  })

  test('a stray scalar element disables hoisting entirely', () => {
    const rows: unknown[] = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      author: 'dev',
    }))
    rows[2] = 5 // 5/6 objects ≥ 80% → still schema-factor, but no hoist
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).not.toContain('const=')
    expect(out.render).toContain('keys=[id,author]')
  })

  test('a long constant value is truncated like a grid cell (full value in jsonl)', () => {
    const big = 'x'.repeat(600)
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, note: big }))
    const out = compressJsonArray(JSON.stringify(rows))!
    expect(out.render).toContain('keys=[id]')
    expect(out.render).toMatch(/const=\{"note":".+…\[\d+b\]\}/)
    // full value survives in the backing
    expect(out.jsonl.split('\n')[0]).toContain(big)
  })
})

describe('compressJsonArray — salient-row preservation', () => {
  // PR-like rows; state alternates OPEN/MERGED. `overrides` patches specific
  // 0-based indices so anomalies can be planted in the dropped middle.
  const mkBig = (
    n: number,
    overrides: Record<number, Record<string, unknown>> = {},
  ) =>
    Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      title: `Pull request ${i + 1}`,
      state: i % 2 === 0 ? 'OPEN' : 'MERGED',
      ...(overrides[i] ?? {}),
    }))
  const run = (rows: unknown[]) => compressJsonArray(JSON.stringify(rows))!
  const omitCounts = (render: string) =>
    [...render.matchAll(/<omitted rows="(\d+)"/g)].map(m => Number(m[1]))
  const gridRow = (render: string, label: string) =>
    render.split('\n').find(l => l.startsWith(`${label}\t`))

  test('benign long array → empty keep-set, single bare marker, byte-identical window', () => {
    const out = run(mkBig(100))
    expect(out.salientPinned).toBe(0)
    expect(out.render).toContain('<omitted rows="50"/>') // single, no range attrs
    expect(out.render).not.toContain('first="#')
    // self-gating lock: exactly the blind window — one omit run + HEAD+TAIL rows
    expect((out.render.match(/<omitted /g) ?? []).length).toBe(1)
    expect(out.render.split('\n').filter(l => l.startsWith('#'))).toHaveLength(50)
  })

  test('rare status value in the dropped middle is pinned (and would be omitted today)', () => {
    // state="DRAFT" at #51 is 1/100 (<10%), 3 distinct, present on all rows, and
    // is NOT an error keyword — so only the rare-value signal fires.
    const out = run(mkBig(100, { 50: { state: 'DRAFT' } }))
    expect(out.salientPinned).toBe(1)
    expect(gridRow(out.render, '#51')).toContain('DRAFT')
    expect(gridRow(out.render, '#45')).toBeUndefined() // ordinary middle row still dropped
    expect(out.jsonl.split('\n')).toHaveLength(100) // reversibility intact
  })

  test('rare boolean value is pinned', () => {
    // mergeable=true on every row except #60 (false) → false is 1/100, rare.
    const rows = mkBig(100).map((r, i) => ({ ...r, mergeable: i !== 59 }))
    const out = run(rows)
    expect(out.salientPinned).toBe(1)
    expect(gridRow(out.render, '#60')).toContain('false')
  })

  test('error keyword nested in a string VALUE is pinned (keys are not scanned)', () => {
    const rows = mkBig(100).map((r, i) => ({
      ...r,
      checks: { conclusion: i === 55 ? 'failure' : 'success' },
    }))
    const out = run(rows)
    expect(out.salientPinned).toBe(1)
    expect(gridRow(out.render, '#56')).toContain('failure')
  })

  test('a keyword in a field KEY (not value) does not pin', () => {
    // key "errorCount" matches the vocabulary; its value never does.
    const rows = mkBig(100).map((r, i) => ({ ...r, errorCount: i % 3 }))
    const out = run(rows)
    expect(out.salientPinned).toBe(0)
  })

  test('a CONSTANT field carrying a keyword does not pin (hoisted, excluded)', () => {
    const rows = mkBig(100).map(r => ({ ...r, category: 'error-handling' }))
    const out = run(rows)
    expect(out.salientPinned).toBe(0)
    expect(out.render).toContain('const={"category":"error-handling"}')
    expect(out.render).toContain('<omitted rows="50"/>')
    expect(out.render).not.toContain('first="#')
  })

  test('a sparse status-like field (<80% present) does not trigger rare-value', () => {
    // tier present on 15/100 rows → below the presence floor; its rare values
    // must not pin. The dominant {number,title,state} signature keeps it homogeneous.
    const ov: Record<number, Record<string, unknown>> = {}
    for (let i = 50; i < 65; i++) ov[i] = { tier: `t${i}` }
    const out = run(mkBig(100, ov))
    expect(out.salientPinned).toBe(0)
  })

  test('multi-segment markers carry the #N range and the counts sum to length−kept', () => {
    const out = run(mkBig(100, { 45: { state: 'DRAFT' }, 70: { state: 'DRAFT' } }))
    expect(out.salientPinned).toBe(2)
    expect(out.render).toContain('first="#41" last="#45"')
    expect(gridRow(out.render, '#46')).toBeDefined()
    expect(gridRow(out.render, '#71')).toBeDefined()
    const kept = 40 + 2 + 10
    expect(omitCounts(out.render).reduce((a, b) => a + b, 0)).toBe(100 - kept)
  })

  test('cap: >SALIENT_MAX salient rows → 20 pinned, header discloses the rest, jsonl complete', () => {
    const ov: Record<number, Record<string, unknown>> = {}
    for (let i = 50; i < 75; i++) ov[i] = { title: `build FAILED #${i}` } // 25 keyword rows
    const out = run(mkBig(200, ov))
    expect(out.salientPinned).toBe(20)
    expect(out.render).toContain('(+5 salient rows omitted)')
    expect(out.jsonl.split('\n')).toHaveLength(200) // every row still recoverable
  })

  test('salient rows already in head/tail are not pinned again (no double render)', () => {
    const out = run(
      mkBig(100, {
        5: { state: 'DRAFT' },
        50: { state: 'DRAFT' },
        95: { state: 'DRAFT' },
      }),
    )
    expect(out.salientPinned).toBe(1) // only the middle one is pinned
    const rows6 = out.render.split('\n').filter(l => l.startsWith('#6\t'))
    expect(rows6).toHaveLength(1) // #6 rendered once (from head), not duplicated
    expect(gridRow(out.render, '#51')).toContain('DRAFT')
  })

  test('heterogeneous (json-lines) path also pins an error-keyword row', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      i === 50 ? { note: 'fatal error in build' } : { [`k${i % 6}`]: i },
    )
    const out = run(rows)
    expect(out.render).toContain('(heterogeneous)')
    expect(out.salientPinned).toBe(1)
    expect(out.render).toContain('fatal error in build')
  })

  test('boundary: length 61 (smallest window), salient at the FIRST middle index (#41)', () => {
    // index 40 === HEAD_ROWS → adjacent to head; must NOT emit a zero-length leading omit.
    const out = run(mkBig(61, { 40: { state: 'DRAFT' } }))
    expect(out.salientPinned).toBe(1)
    expect(gridRow(out.render, '#41')).toContain('DRAFT')
    expect(omitCounts(out.render).every(c => c > 0)).toBe(true)
  })

  test('boundary: salient at the LAST middle index (#51, adjacent to tail) — no trailing zero-run', () => {
    const out = run(mkBig(61, { 50: { state: 'DRAFT' } })) // index 50 === midEnd-1
    expect(out.salientPinned).toBe(1)
    expect(gridRow(out.render, '#51')).toContain('DRAFT')
    expect(omitCounts(out.render).every(c => c > 0)).toBe(true)
  })

  test('cap priority + re-sort: 20 high-index keyword rows beat low-index rare; walk stays monotone', () => {
    const ov: Record<number, Record<string, unknown>> = {}
    for (let i = 150; i < 170; i++) ov[i] = { title: `build FAILED #${i}` } // 20 keyword (high idx)
    ov[50] = { state: 'DRAFT' } // rare (low idx) — loses the priority cut
    ov[60] = { state: 'DRAFT' }
    const out = run(mkBig(200, ov))
    expect(out.salientPinned).toBe(20)
    expect(gridRow(out.render, '#51')).toBeUndefined() // dropped, not pinned
    // every emitted range marker is forward (#first <= #last) — proves keep is sorted post-cap
    const ranges = [...out.render.matchAll(/first="#(\d+)" last="#(\d+)"/g)]
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges.every(m => Number(m[1]) <= Number(m[2]))).toBe(true)
  })
})
