import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileFingerprints,
  gramHashes,
  K,
  matchedLines,
  PARAMS,
  type ReferenceSets,
  tokenize,
  UNINFORMATIVE,
  W,
  winnow,
} from './fingerprint.js'
import { decodeReference, encodeReference, loadReference, type Reference } from './reference.js'

/** A realistic block of code whose every identifier is chosen by `name`. */
function program(name: (identifier: string) => string): string {
  const n = name
  return `
export async function ${n('loadSettings')}(${n('path')}: string, ${n('options')}: { strict?: boolean } = {}) {
  const ${n('raw')} = await ${n('readFile')}(${n('path')}, 'utf8')
  let ${n('parsed')}: Record<string, unknown>
  try {
    ${n('parsed')} = JSON.${n('parse')}(${n('raw')}) as Record<string, unknown>
  } catch (${n('error')}) {
    if (${n('options')}.${n('strict')}) throw new ${n('SettingsError')}(\`bad json in \${${n('path')}}\`)
    return { ${n('ok')}: false, ${n('reason')}: 'parse' } as const
  }
  for (const [${n('key')}, ${n('value')}] of Object.${n('entries')}(${n('parsed')})) {
    if (typeof ${n('value')} === 'string' && ${n('value')}.length > 1024) {
      delete ${n('parsed')}[${n('key')}]
      continue
    }
    if (Array.isArray(${n('value')})) {
      ${n('parsed')}[${n('key')}] = ${n('value')}.filter(${n('item')} => ${n('item')} !== null).slice(0, 50)
    }
  }
  const ${n('merged')} = { ...${n('DEFAULTS')}, ...${n('parsed')} }
  while (${n('queue')}.length > 0 && ${n('budget')}-- > 0) {
    const ${n('next')} = ${n('queue')}.shift()
    if (!${n('next')}) break
    ${n('merged')}[${n('next')}.${n('name')}] = await ${n('resolveRef')}(${n('next')}, ${n('merged')})
  }
  switch (${n('merged')}.${n('mode')}) {
    case 'fast':
      return { ${n('ok')}: true, ${n('settings')}: ${n('merged')}, ${n('elapsed')}: Date.now() - ${n('start')} }
    case 'safe':
      ${n('validate')}(${n('merged')}, ${n('SCHEMA')}, { ${n('depth')}: 3 })
      return { ${n('ok')}: true, ${n('settings')}: ${n('merged')}, ${n('elapsed')}: 0 }
    default:
      return { ${n('ok')}: false, ${n('reason')}: 'mode' } as const
  }
}
`
}

const original = program(identifier => identifier)
const renamed = program(identifier => `renamed_${identifier.length}_${identifier.split('').reverse().join('')}`)

function referenceOf(source: string, withTokens = true): ReferenceSets {
  const { lines, grams } = fileFingerprints(source, withTokens)
  return { lines: new Set(lines), grams: new Set(grams) }
}

describe('tokenize', () => {
  test('collapses identifiers, strings and numbers, and drops comments', () => {
    expect(tokenize(`const total = 'x' + 12 // trailing\n/* block */ total`).kinds).toEqual([
      'const', 'I', '=', 'S', '+', 'N', 'I',
    ])
  })

  test('renaming every identifier leaves the stream unchanged', () => {
    expect(tokenize(renamed).kinds).toEqual(tokenize(original).kinds)
  })

  test('drops imports and re-exports, keeps import.meta and a property named import', () => {
    const source = [
      `import { a, b } from 'mod'`,
      `import type T from 'types'`,
      `export { c } from 'other'`,
      `export * as ns from 'all'`,
      `const url = import.meta.url`,
      `const lazy = await import('lazy')`,
      `loader.import(x)`,
    ].join('\n')
    expect(tokenize(source).kinds).toEqual([
      'const', 'I', '=', 'import', '.', 'I', '.', 'I',
      'const', 'I', '=', 'await',
      'I', '.', 'import', '(', 'I', ')',
    ])
  })

  test('tells a regex literal from a division', () => {
    expect(tokenize(`const r = /a'b[/]/g; const d = x / y / z`).kinds).toEqual([
      'const', 'I', '=', 'R', ';', 'const', 'I', '=', 'I', '/', 'I', '/', 'I',
    ])
  })

  test('a template swallows its nested expressions, braces and all', () => {
    expect(tokenize('const s = `a ${ {b: `}`}.b } c` + 1').kinds).toEqual(['const', 'I', '=', 'S', '+', 'N'])
  })

  test('keeps the line of every token', () => {
    expect(tokenize('a\n\nb /* x\n y */ c').lines).toEqual([0, 2, 3])
  })
})

describe('grams and winnowing', () => {
  test('a table-shaped stream has no informative gram', () => {
    const table = Array.from({ length: 50 }, () => ['I', ':', 'S', ',']).flat()
    expect(gramHashes(table).every(h => h === UNINFORMATIVE)).toBe(true)
  })

  test('two streams sharing K + W - 1 informative tokens share a fingerprint', () => {
    const vocabulary = ['I', '(', ')', '{', '}', '=', 'S', 'N', ';', 'return', 'if', 'const', '.', ',', '+', 'await']
    let seed = 7
    const random = (length: number) =>
      Array.from({ length }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
        return vocabulary[seed % vocabulary.length]!
      })
    const shared = random(K + W - 1)
    const a = winnow(gramHashes([...random(60), ...shared, ...random(60)]))
    const b = winnow(gramHashes([...random(45), ...shared, ...random(80)]))
    expect(a.some(h => b.includes(h))).toBe(true)
  })
})

describe('matchedLines', () => {
  test('finds a copy whose identifiers were all renamed', () => {
    const covered = matchedLines(renamed, referenceOf(original), true)
    const lines = renamed.split('\n').filter(l => l.trim() !== '').length
    expect(covered.size).toBeGreaterThan(lines * 0.8)
    // The line measure alone sees nothing: that is the gap the tokens close.
    expect(matchedLines(renamed, referenceOf(original), false).size).toBe(0)
  })

  test('finds nothing in unrelated code', () => {
    const unrelated = `
class Queue<T> {
  private items: T[] = []
  enqueue(item: T): void { this.items.push(item) }
  dequeue(): T | undefined { return this.items.shift() }
  get size(): number { return this.items.length }
}
export function drain<T>(queue: Queue<T>, visit: (item: T) => void): number {
  let visited = 0
  for (let item = queue.dequeue(); item !== undefined; item = queue.dequeue()) {
    visit(item)
    visited += 1
  }
  return visited
}
`
    expect(matchedLines(unrelated, referenceOf(original), true).size).toBe(0)
  })

  test('import and re-export lines never count, however long', () => {
    const wiring = [
      `import { randomBytes, createHash } from 'crypto'`,
      `import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'`,
      `} from 'src/shared/types/command.js'`,
      `export { getBundledSkills, clearBundledSkills } from './bundledSkills.js'`,
      `export type { BundledSkillDefinition } from './bundledSkills.js'`,
    ].join('\n')
    expect(matchedLines(wiring, referenceOf(wiring, false), false).size).toBe(0)
  })

  test('a lone matching line is chance; two in a row count', () => {
    const reference = referenceOf(
      ['the first distinctive sentence of prose', 'the second distinctive sentence of prose'].join('\n'),
      false,
    )
    const lone = ['unrelated line that is long enough', 'the first distinctive sentence of prose', 'another unrelated long line here']
    expect(matchedLines(lone.join('\n'), reference, false).size).toBe(0)
    const pair = ['unrelated line that is long enough', 'the first distinctive sentence of prose', 'the second distinctive sentence of prose']
    expect([...matchedLines(pair.join('\n'), reference, false)].sort()).toEqual([1, 2])
  })
})

describe('reference file', () => {
  const reference: Reference = {
    header: { params: PARAMS, sources: { claudeCode: 'a', openclaude: 'b' }, builtAt: '2026-09-27' },
    claudeCode: { lines: new Set([0, 1, 2 ** 32 - 1, 123456789]), grams: new Set([42]) },
    openclaude: { lines: new Set(), grams: new Set([7, 3_000_000_000]) },
  }

  test('round-trips every set and the header', () => {
    const decoded = decodeReference(encodeReference(reference))
    expect(decoded.header).toEqual(reference.header)
    expect([...decoded.claudeCode.lines].sort((a, b) => a - b)).toEqual([0, 1, 123456789, 2 ** 32 - 1])
    expect([...decoded.claudeCode.grams]).toEqual([42])
    expect([...decoded.openclaude.lines]).toEqual([])
    expect([...decoded.openclaude.grams].sort((a, b) => a - b)).toEqual([7, 3_000_000_000])
  })

  test('refuses a reference built under other parameters', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'provenance-')), 'fingerprints.bin')
    const stale = { ...reference, header: { ...reference.header, params: { ...PARAMS, K: K + 1 } } }
    writeFileSync(path, encodeReference(stale as unknown as Reference))
    expect(() => loadReference(path)).toThrow(/bun run provenance:fingerprints/)
  })
})
