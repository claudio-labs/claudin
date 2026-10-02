/**
 * The core of the `bodies` sandbox (docs/tech/rewrite/levers.md, "Método a
 * método"): in one file, the body of every function or method that holds an
 * inherited line is replaced by a stub that throws, and nothing else changes.
 * Signatures, types, imports and the functions with no inherited line stay, so
 * the implementer sees the file with holes, never the old bodies.
 *
 * A function here is an outermost one: a declaration, a method, or a function
 * assigned to a top-level name or property. A callback inside it is part of
 * its body. Bodies are found with oxc-parser rather than the outline scanner,
 * whose ranges go wrong on an object-typed parameter.
 *
 * What it does not stub is reported for a person to decide:
 * - `residue`: inherited lines on a signature, which the public contract dictates;
 * - `unlocated`: inherited lines in a declaration that is not a function (a table,
 *   a type, a class field) or between declarations, rewritten as a whole.
 * An inherited comment outside the stubbed bodies is taken out with them, since
 * a doc comment is prose of the old code; `comments` lists its lines.
 */
import { parseSync } from 'oxc-parser'

export type StubbedSymbol = { name: string; startLine: number; endLine: number }

export type BodiesResult = {
  text: string
  stubbed: StubbedSymbol[]
  /** 1-indexed inherited lines on the signature of a function. */
  residue: number[]
  /** Inherited lines outside any function body, with the declaration that holds them. */
  unlocated: { line: number; symbol: string | null }[]
  /** 1-indexed lines of the inherited comments taken out. */
  comments: number[]
}

type Node = { type: string; start: number; end: number; [key: string]: unknown }

type FunctionSite = {
  name: string
  start: number
  /** The body: a block, or the expression of an arrow. */
  bodyStart: number
  bodyEnd: number
  isBlock: boolean
}

type Edit = { start: number; end: number; replacement: string }

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const LEADING_INDENT_RE = /^\s*/

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

function keyName(key: unknown): string | null {
  if (!isNode(key)) return null
  if (key.type === 'Identifier' || key.type === 'PrivateIdentifier') return String(key.name)
  if (key.type === 'Literal') return String(key.value)
  return null
}

/** The outermost functions of the program, each named after what holds it. */
function outermostFunctions(program: Node): FunctionSite[] {
  const sites: FunctionSite[] = []
  const visit = (value: unknown, nameHint: string | null): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, nameHint)
      return
    }
    if (!isNode(value)) return
    if (FUNCTION_TYPES.has(value.type)) {
      const body = value.body as Node
      const ownName = isNode(value.id) ? String(value.id.name) : null
      sites.push({
        name: ownName ?? nameHint ?? '<anonymous>',
        start: value.start,
        bodyStart: body.start,
        bodyEnd: body.end,
        isBlock: body.type === 'BlockStatement',
      })
      return
    }
    for (const [field, child] of Object.entries(value)) {
      if (field === 'type' || field === 'start' || field === 'end') continue
      let hint = nameHint
      if (value.type === 'VariableDeclarator' && field === 'init') hint = keyName(value.id)
      else if (
        (value.type === 'MethodDefinition' || value.type === 'PropertyDefinition' || value.type === 'Property') &&
        field === 'value'
      ) {
        hint = keyName(value.key)
      }
      visit(child, hint)
    }
  }
  visit(program.body, null)
  return sites
}

/** The name a top-level statement declares, looking through `export`. */
function declaredName(statement: Node): string | null {
  const inner = isNode(statement.declaration) ? statement.declaration : statement
  if (isNode(inner.id)) return keyName(inner.id)
  const declarations = inner.declarations
  if (Array.isArray(declarations) && isNode(declarations[0])) return keyName(declarations[0].id)
  return null
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

/** 1-indexed line of `offset`: the count of line starts at or before it. */
function lineOf(starts: number[], offset: number): number {
  return starts.findLastIndex(start => start <= offset) + 1
}

export function stripInheritedBodies(file: string, source: string, inherited: Set<number>): BodiesResult {
  const result: BodiesResult = { text: source, stubbed: [], residue: [], unlocated: [], comments: [] }
  if (inherited.size === 0) return result

  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    throw new Error(`${file} does not parse: ${parsed.errors.map(e => e.message).join('; ')}`)
  }
  const program = parsed.program as unknown as Node
  const starts = lineStarts(source)
  const sites = outermostFunctions(program)
  const statements = (program.body as Node[]).map(statement => ({
    statement,
    startLine: lineOf(starts, statement.start),
    endLine: lineOf(starts, statement.end - 1),
  }))
  const comments = parsed.comments.map(c => ({
    start: c.start,
    end: c.end,
    startLine: lineOf(starts, c.start),
    endLine: lineOf(starts, c.end - 1),
  }))

  const toStub = new Set<FunctionSite>()
  const looseComments = new Set<(typeof comments)[number]>()
  for (const line of [...inherited].sort((a, b) => a - b)) {
    const site = sites.find(s => line >= lineOf(starts, s.start) && line <= lineOf(starts, s.bodyEnd - 1))
    const comment = comments.find(c => line >= c.startLine && line <= c.endLine)
    if (site === undefined) {
      if (comment !== undefined) {
        looseComments.add(comment)
        continue
      }
      const holder = statements.find(s => line >= s.startLine && line <= s.endLine)
      result.unlocated.push({ line, symbol: holder ? declaredName(holder.statement) : null })
      continue
    }
    const bodyFirstLine = lineOf(starts, site.bodyStart)
    // A block's opening line is still the signature; an expression body starts on its own line.
    if (site.isBlock ? line <= bodyFirstLine : line < bodyFirstLine) result.residue.push(line)
    else toStub.add(site)
  }

  const edits: Edit[] = []
  for (const site of toStub) {
    const startLine = lineOf(starts, site.start)
    const indent = LEADING_INDENT_RE.exec(source.slice(starts[startLine - 1]!))![0]
    const replacement = `{\n${indent}  throw new Error('not rewritten: ${site.name}')\n${indent}}`
    edits.push({ start: site.bodyStart, end: site.bodyEnd, replacement })
  }
  const insideStub = (offset: number) => [...toStub].some(s => offset >= s.bodyStart && offset < s.bodyEnd)
  for (const comment of looseComments) {
    if (insideStub(comment.start)) continue
    // A comment alone on its lines takes the lines with it.
    const lineStart = starts[comment.startLine - 1]!
    const lineEnd = comment.endLine < starts.length ? starts[comment.endLine]! : source.length
    const alone =
      source.slice(lineStart, comment.start).trim() === '' && source.slice(comment.end, lineEnd).trim() === ''
    edits.push(alone ? { start: lineStart, end: lineEnd, replacement: '' } : { ...comment, replacement: '' })
    for (let line = comment.startLine; line <= comment.endLine; line++) result.comments.push(line)
  }

  // From the end, so earlier offsets stay valid.
  let text = source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
  }
  result.text = text
  result.stubbed = [...toStub]
    .map(site => ({
      name: site.name,
      startLine: lineOf(starts, site.start),
      endLine: lineOf(starts, site.bodyEnd - 1),
    }))
    .sort((a, b) => a.startLine - b.startLine)
  return result
}
