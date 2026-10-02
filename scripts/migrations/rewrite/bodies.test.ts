import { describe, expect, test } from 'bun:test'
import { stripInheritedBodies } from './bodies.js'

const SOURCE = [
  "import { join } from 'node:path'", // 1
  '', // 2
  'export type Options = { base: string; depth: number }', // 3
  '', // 4
  'export function inherited(options: Options): string {', // 5
  '  const parts = [options.base]', // 6
  '  for (let i = 0; i < options.depth; i++) parts.push(`level-${i}`)', // 7
  '  return join(...parts)', // 8
  '}', // 9
  '', // 10
  'export function own(value: number): number {', // 11
  '  return value * 2', // 12
  '}', // 13
  '', // 14
].join('\n')

const lines = (...numbers: number[]) => new Set(numbers)

/** Every line of `before` outside [from, to] (1-indexed, inclusive) is in `after`, in order. */
function outsideIsUntouched(before: string, after: string, from: number, to: number): void {
  const b = before.split('\n')
  const a = after.split('\n')
  expect(a.slice(0, from - 1)).toEqual(b.slice(0, from - 1))
  const tail = b.length - to
  expect(a.slice(a.length - tail)).toEqual(b.slice(to))
}

describe('stripInheritedBodies', () => {
  test('stubs the body of the function that holds an inherited line, and only that one', () => {
    const result = stripInheritedBodies('x.ts', SOURCE, lines(7))
    expect(result.stubbed).toEqual([{ name: 'inherited', startLine: 5, endLine: 9 }])
    expect(result.text).toContain('export function inherited(options: Options): string {')
    expect(result.text).toContain("throw new Error('not rewritten: inherited')")
    expect(result.text).not.toContain('parts.push')
    expect(result.text).toContain('  return value * 2')
    expect(result.text).toContain('export type Options = { base: string; depth: number }')
    expect(result.unlocated).toEqual([])
    outsideIsUntouched(SOURCE, result.text, 5, 9)
  })

  test('leaves a file without inherited lines as it is', () => {
    const result = stripInheritedBodies('x.ts', SOURCE, lines())
    expect(result.text).toBe(SOURCE)
    expect(result.stubbed).toEqual([])
  })

  test('a match on the signature alone is residue, not a body to stub', () => {
    const result = stripInheritedBodies('x.ts', SOURCE, lines(5))
    expect(result.stubbed).toEqual([])
    expect(result.residue).toEqual([5])
    expect(result.text).toBe(SOURCE)
  })

  test('a declaration that is not a function is reported, not stubbed', () => {
    const result = stripInheritedBodies('x.ts', SOURCE, lines(3))
    expect(result.stubbed).toEqual([])
    expect(result.unlocated).toEqual([{ line: 3, symbol: 'Options' }])
  })

  test('a class method is stubbed on its own, and a field of the class is reported', () => {
    const source = [
      'export class Counter {', // 1
      '  private total = 0', // 2
      '  add(step: number): void {', // 3
      '    this.total += step', // 4
      '  }', // 5
      '  read(): number {', // 6
      '    return this.total', // 7
      '  }', // 8
      '}', // 9
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(2, 4))
    expect(result.stubbed.map(s => s.name)).toEqual(['add'])
    expect(result.text).toContain("    throw new Error('not rewritten: add')")
    expect(result.text).toContain('    return this.total')
    expect(result.unlocated).toEqual([{ line: 2, symbol: 'Counter' }])
  })

  test('an arrow function with a multi-line signature and an object-typed parameter', () => {
    const source = [
      'export const render = (', // 1
      '  { title, body }: { title: string; body: string },', // 2
      '  width: number,', // 3
      '): string => {', // 4
      '  const rule = "-".repeat(width)', // 5
      '  return `${title}\\n${rule}\\n${body}`', // 6
      '}', // 7
      'export const VERSION = 3', // 8
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(5, 6))
    expect(result.stubbed).toEqual([{ name: 'render', startLine: 1, endLine: 7 }])
    expect(result.text.split('\n').slice(0, 4)).toEqual(source.split('\n').slice(0, 4))
    expect(result.text).toContain('export const VERSION = 3')
    expect(result.text).not.toContain('repeat(width)')
  })

  test('braces inside strings and comments do not move the body', () => {
    const source = [
      'export function braces(): string {', // 1
      "  // a } in a comment, and { another", // 2
      "  return '}' + \"{\" + `}`", // 3
      '}', // 4
      'export const after = 1', // 5
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(3))
    expect(result.stubbed.map(s => s.name)).toEqual(['braces'])
    expect(result.text).toBe(
      [
        'export function braces(): string {',
        "  throw new Error('not rewritten: braces')",
        '}',
        'export const after = 1',
      ].join('\n'),
    )
  })

  test('a function in a table is a method of it; the data around it is reported', () => {
    const source = [
      'export const HANDLERS: Record<string, () => void> = {', // 1
      "  start: () => console.log('start'),", // 2
      '}', // 3
      'export const LIMITS = {', // 4
      '  maxDepth: 3,', // 5
      '}', // 6
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(2, 5))
    expect(result.stubbed).toEqual([{ name: 'start', startLine: 2, endLine: 2 }])
    expect(result.text).toContain("  start: () => {\n    throw new Error('not rewritten: start')\n  },")
    expect(result.unlocated).toEqual([{ line: 5, symbol: 'LIMITS' }])
  })

  test('a React component in a .tsx keeps its props signature and loses its JSX', () => {
    const source = [
      'type Props = { label: string }', // 1
      'export function Badge({ label }: Props): React.ReactNode {', // 2
      '  const shown = label.toUpperCase()', // 3
      '  return <Text bold>{shown}</Text>', // 4
      '}', // 5
    ].join('\n')
    const result = stripInheritedBodies('x.tsx', source, lines(3, 4))
    expect(result.stubbed).toEqual([{ name: 'Badge', startLine: 2, endLine: 5 }])
    expect(result.text).toContain('export function Badge({ label }: Props): React.ReactNode {')
    expect(result.text).not.toContain('<Text')
  })

  test('an inherited line between declarations is reported with no symbol', () => {
    const source = ['export const a = 1', "console.log('loaded at import time')", 'export const b = 2'].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(2))
    expect(result.unlocated).toEqual([{ line: 2, symbol: null }])
  })

  test('a nested callback is part of the function that holds it', () => {
    const source = [
      'export function total(values: number[]): number {', // 1
      '  return values.reduce((sum, value) => {', // 2
      '    return sum + value', // 3
      '  }, 0)', // 4
      '}', // 5
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(3))
    expect(result.stubbed).toEqual([{ name: 'total', startLine: 1, endLine: 5 }])
  })

  test('a file that does not parse is refused rather than half-stubbed', () => {
    expect(() => stripInheritedBodies('x.ts', 'export function broken( {', lines(1))).toThrow('does not parse')
  })

  test('an inherited doc comment goes with its lines; an own comment stays', () => {
    const source = [
      '/**', // 1
      ' * Inherited prose about the function below.', // 2
      ' */', // 3
      'export function documented(): number {', // 4
      '  return 1', // 5
      '}', // 6
      '// our own note', // 7
      'export const flag = true // inherited trailing remark', // 8
    ].join('\n')
    const result = stripInheritedBodies('x.ts', source, lines(2, 8))
    expect(result.comments).toEqual([1, 2, 3, 8])
    expect(result.text).toBe(
      ['export function documented(): number {', '  return 1', '}', '// our own note', 'export const flag = true '].join(
        '\n',
      ),
    )
    expect(result.unlocated).toEqual([])
  })
})
