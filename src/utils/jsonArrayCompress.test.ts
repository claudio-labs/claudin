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
