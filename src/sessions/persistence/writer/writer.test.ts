/**
 * The pure pieces of the transcript writer, case by case. The behaviour they
 * add up to is pinned by the characterization suites in `src/sessions/`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { flattenPrompt } from 'src/sessions/persistence/writer/lastPrompt.js'
import { planRecording } from 'src/sessions/persistence/writer/lines.js'
import { metadataBlock, readExternalWrites } from 'src/sessions/persistence/writer/metadataBlock.js'
import { isSafeAgentId } from 'src/sessions/persistence/writer/remote.js'
import { removeMessageLine } from 'src/sessions/persistence/writer/remover.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID

describe('planRecording', () => {
  const cases: Array<{ name: string; call: number[]; recorded: number[]; hint?: number; fresh: number[]; parent: number | null; last: number | null }> = [
    { name: 'all new', call: [1, 2], recorded: [], fresh: [1, 2], parent: null, last: 2 },
    { name: 'recorded prefix moves the parent', call: [1, 2, 3], recorded: [1, 2], fresh: [3], parent: 2, last: 3 },
    { name: 'recorded after the first new does not', call: [5, 1], recorded: [1], fresh: [5], parent: null, last: 5 },
    { name: 'the hint when nothing leads', call: [3], recorded: [], hint: 9, fresh: [3], parent: 9, last: 3 },
    { name: 'a recorded prefix beats the hint', call: [1], recorded: [1], hint: 9, fresh: [], parent: 1, last: 1 },
    { name: 'a uuid twice in one call is written once', call: [1, 1, 2], recorded: [], fresh: [1, 2], parent: null, last: 2 },
    { name: 'nothing', call: [], recorded: [], fresh: [], parent: null, last: null },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const recorded = new Set(c.recorded.map(id))
      const plan = planRecording(c.call.map(n => ({ uuid: id(n) })), uuid => recorded.has(uuid), c.hint === undefined ? undefined : id(c.hint))
      expect({ fresh: plan.fresh.map(m => m.uuid), parent: plan.parent, last: plan.last }).toEqual({
        fresh: c.fresh.map(id),
        parent: c.parent === null ? null : id(c.parent),
        last: c.last === null ? null : id(c.last),
      })
    })
  }
})

describe('flattenPrompt', () => {
  const cases: Array<[string, string]> = [
    ['plain', 'plain'],
    ['  a\nb  ', 'a b'],
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['x'.repeat(200), 'x'.repeat(200)],
    [`${'y'.repeat(199)} z`, `${'y'.repeat(199)}\u2026`],
  ]
  for (const [input, output] of cases) {
    test(JSON.stringify(input.slice(0, 20)), () => expect(flattenPrompt(input)).toBe(output))
  }
})

describe('metadataBlock', () => {
  test('nothing cached, nothing written', () => {
    expect(metadataBlock({}, id(1), new Date(0))).toEqual([])
  })

  test('a null worktree is written, an undefined one is not', () => {
    expect(metadataBlock({ worktree: null }, id(1), new Date(0)).map(l => l.type)).toEqual(['worktree-state'])
    expect(metadataBlock({ worktree: undefined }, id(1), new Date(0))).toEqual([])
  })
})

describe('readExternalWrites', () => {
  const cases: Array<{ name: string; tail: string; found: { title?: string; tag?: string } }> = [
    { name: 'the last of each wins', tail: '{"type":"tag","tag":"a"}\n{"type":"custom-title","customTitle":"T1"}\n{"type":"tag","tag":"b"}\n', found: { title: 'T1', tag: 'b' } },
    { name: 'an empty value is reported as empty', tail: '{"type":"tag","tag":""}\n', found: { tag: '' } },
    { name: 'a line cut by the window does not count', tail: 'tag","tag":"cut"}\n', found: {} },
    { name: 'escapes are decoded', tail: '{"type":"custom-title","customTitle":"a \\"b\\""}\n', found: { title: 'a "b"' } },
  ]
  for (const c of cases) test(c.name, () => expect(readExternalWrites(c.tail)).toEqual(c.found))
})

describe('isSafeAgentId', () => {
  const cases: Array<[string | undefined, boolean]> = [
    ['a0f3c9', true],
    ['agent-x', true],
    ['name@team', true],
    [undefined, false],
    ['', false],
    ['..', false],
    ['../x', false],
    ['x/y', false],
    ['x\\y', false],
    ['x\0y', false],
    ['a'.repeat(129), false],
  ]
  for (const [agentId, safe] of cases) test(String(agentId).slice(0, 20), () => expect(isSafeAgentId(agentId)).toBe(safe))
})

describe('removeMessageLine', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const limits = { tailBytes: 64, maxRewriteBytes: 10_000 }
  const line = (n: number, pad = '') => JSON.stringify({ uuid: id(n), pad })

  const cases: Array<{ name: string; text: string; target: number; expected: string; limits?: typeof limits }> = [
    { name: 'the last line, unterminated', text: `${line(1)}\n${line(2)}`, target: 2, expected: `${line(1)}\n` },
    // No rewrite allowed: only the in-place cut can pass.
    { name: 'a line starting exactly at the window', text: `${line(1, 'x'.repeat(40))}\n${line(2)}\n`, target: 2, expected: `${line(1, 'x'.repeat(40))}\n`, limits: { tailBytes: line(2).length + 1, maxRewriteBytes: 0 } },
    { name: 'outside the window: rewritten', text: `${line(1)}\n${line(2, 'x'.repeat(80))}\n`, target: 1, expected: `${line(2, 'x'.repeat(80))}\n` },
    { name: 'over the rewrite limit: left alone', text: `${line(1)}\n${line(2, 'x'.repeat(80))}\n`, target: 1, expected: `${line(1)}\n${line(2, 'x'.repeat(80))}\n`, limits: { tailBytes: 64, maxRewriteBytes: 50 } },
    { name: 'not there: unchanged', text: `${line(1)}\n`, target: 3, expected: `${line(1)}\n` },
  ]
  for (const c of cases) {
    test(c.name, async () => {
      dir = mkdtempSync(join(tmpdir(), 'remover-'))
      const file = join(dir, 't.jsonl')
      writeFileSync(file, c.text)
      await removeMessageLine(file, id(c.target), c.limits ?? limits)
      expect(readFileSync(file, 'utf8')).toBe(c.expected)
    })
  }
})
