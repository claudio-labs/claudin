// The fixture, answer key and grader of subagent-audit-ab.ts: a TypeScript
// project generated from a seed, and the audit a sub-agent is handed over it.
//
// The shape is the real corpus's: an audit sub-agent makes a median of 64
// calls, 69% of them with one tool, and in 5.8% of its calls a Read follows a
// Grep that found the file (team memory `request-count-levers-2026-09-24`,
// round 4). The earlier sub-agent bench (subagent-batching-ab.ts) asked for
// facts one Bash loop answers, so its base arm never serialized. Here every
// answer needs a hop the search before it reveals:
//
//   - five areas under src/, eight modules each, three exported functions per
//     module (verb + Noun names, so no name contains another);
//   - each function calls 0-2 functions of other modules. An import is direct,
//     aliased (`import { loadLedger as safeLedger }`), through the other
//     area's index.ts, or through a name that index.ts renames
//     (`export { loadLedger as ledgerLoad }`), sometimes aliased again — so
//     a search for a function's name misses the call sites that use another;
//   - half the modules have a test under test/, which imports a few of the
//     module's functions, some of them aliased.
//
// The audit names ten functions. For each, the answer is its definition
// (`file:line`), every call site under src/ (`file:line`), and whether any
// file under test/ calls it. The generator writes every line itself, so the
// key is exact; `observedTargets` re-derives it from the files, resolving the
// imports independently, and the dry run checks the two agree.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const AREAS = ['billing', 'catalog', 'orders', 'users', 'shipping'] as const
const MODULE_WORDS: Record<(typeof AREAS)[number], string[]> = {
  billing: ['ledger', 'invoice', 'refund', 'payout', 'tariff', 'voucher', 'receipt', 'credit'],
  catalog: ['product', 'variant', 'pricing', 'stock', 'bundle', 'category', 'supplier', 'barcode'],
  orders: ['cart', 'checkout', 'fulfil', 'returns', 'basket', 'quote', 'backlog', 'dispatch'],
  users: ['account', 'profile', 'session', 'consent', 'address', 'loyalty', 'contact', 'avatar'],
  shipping: ['parcel', 'carrier', 'route', 'customs', 'pallet', 'depot', 'label', 'tracking'],
}
const FUNCTIONS_PER_MODULE = 3
export const TARGETS = 10

// verb + Noun: no verb ends another verb and no noun starts another noun, so
// no function name contains another. Aliases are adjective + Noun and index
// renames noun + Verb, so neither contains a function name either.
const VERBS = ['load', 'parse', 'merge', 'split', 'score', 'flush', 'render', 'clamp', 'index', 'queue', 'trace', 'shift', 'fetch', 'build']
const NOUNS = ['Ledger', 'Cursor', 'Bucket', 'Frame', 'Packet', 'Token', 'Window', 'Schema', 'Record', 'Vector', 'Socket', 'Header', 'Matrix', 'Buffer']
const ADJECTIVES = ['safe', 'raw', 'core', 'main', 'next', 'prev', 'soft', 'hard', 'cold', 'warm', 'wide', 'thin', 'deep', 'flat']

type ImportStyle = 'direct' | 'alias' | 'barrel' | 'barrelRename' | 'barrelRenameAlias'

export type Fn = { name: string; area: string; module: string; file: string; line: number }
export type Target = { name: string; defined: string; callers: string[]; tested: boolean }
export type AuditFixture = { files: Record<string, string>; targets: Target[] }

/** xorshift32, seeded by the rep: a rep's fixture is the same for every arm and every rerun. */
function rng(seed: number): () => number {
  let x = Math.imul(seed, 0x9e3779b1) >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 0x1_0000_0000
  }
}

function shuffle<T>(xs: readonly T[], next: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const t = a[i]!
    a[i] = a[j]!
    a[j] = t
  }
  return a
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The import specifier from `fromFile` to a module, or to an area's index when
 * `module` is null. Tests and same-area imports always name the module.
 */
function specifier(fromFile: string, area: string, module: string | null): string {
  if (fromFile.startsWith('test/')) return `../../src/${area}/${module}`
  if (fromFile.split('/')[1] === area) return `./${module}`
  return module ? `../${area}/${module}` : `../${area}`
}

/** Rep's project, and what a correct audit of its ten targets says. */
export function auditFixture(rep: number): AuditFixture {
  const next = rng(rep)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
  const names = shuffle(VERBS.flatMap(v => NOUNS.map(n => v + n)), next)
  const aliases = shuffle(ADJECTIVES.flatMap(a => NOUNS.map(n => a + n)), next)
  let takenAlias = 0

  // Functions, by module.
  const fns: Fn[] = []
  const modulesOf = new Map<string, Fn[]>()
  let taken = 0
  for (const area of AREAS) {
    for (const module of MODULE_WORDS[area]) {
      const file = `src/${area}/${module}.ts`
      const own = names.slice(taken, taken + FUNCTIONS_PER_MODULE).map(name => ({ name, area, module, file, line: 0 }))
      taken += FUNCTIONS_PER_MODULE
      fns.push(...own)
      modulesOf.set(file, own)
    }
  }

  // Each area's index renames a few of its functions (noun + Verb).
  const renamed = new Map<string, string>()
  for (const fn of fns) {
    if (next() < 0.2) {
      const verb = VERBS.find(v => fn.name.startsWith(v))!
      const noun = fn.name.slice(verb.length)
      renamed.set(fn.name, `${noun.toLowerCase()}${cap(verb)}`)
    }
  }

  // Calls: 0-2 functions of other modules each.
  const calls = new Map<string, Fn[]>()
  for (const fn of fns) {
    const n = Math.floor(next() * 3)
    const others = shuffle(fns.filter(f => f.file !== fn.file), next).slice(0, n)
    calls.set(fn.name, others)
  }

  const files: Record<string, string> = {}
  const callSites = new Map<string, string[]>()
  const testedBy = new Set<string>()

  /**
   * One file's import lines, and the token each imported function is called by.
   * A function imported once per file, in the style drawn for it there.
   */
  const importsFor = (fromFile: string, callees: readonly Fn[], styles: readonly ImportStyle[]) => {
    const tokenOf = new Map<string, string>()
    const bySource = new Map<string, string[]>()
    for (const callee of callees) {
      if (tokenOf.has(callee.name)) continue
      const sameArea = !fromFile.startsWith('test/') && fromFile.split('/')[1] === callee.area
      let style = pick(styles)
      if (sameArea && style !== 'direct' && style !== 'alias') style = 'direct'
      if ((style === 'barrelRename' || style === 'barrelRenameAlias') && !renamed.has(callee.name)) style = 'barrel'
      const spec = specifier(fromFile, callee.area, style === 'direct' || style === 'alias' ? callee.module : null)
      let binding = callee.name
      let token = callee.name
      if (style === 'alias') {
        token = aliases[takenAlias++]!
        binding = `${callee.name} as ${token}`
      } else if (style === 'barrelRename') {
        token = renamed.get(callee.name)!
        binding = token
      } else if (style === 'barrelRenameAlias') {
        token = aliases[takenAlias++]!
        binding = `${renamed.get(callee.name)!} as ${token}`
      }
      tokenOf.set(callee.name, token)
      bySource.set(spec, [...(bySource.get(spec) ?? []), binding])
    }
    const lines = [...bySource].sort(([a], [b]) => a.localeCompare(b)).map(([spec, bindings]) => `import { ${bindings.join(', ')} } from '${spec}'`)
    return { lines, tokenOf }
  }

  const SRC_STYLES: ImportStyle[] = ['direct', 'direct', 'alias', 'barrel', 'barrelRename', 'barrelRenameAlias']
  for (const [file, own] of modulesOf) {
    const callees = own.flatMap(fn => calls.get(fn.name)!)
    const { lines: imports, tokenOf } = importsFor(file, callees, SRC_STYLES)
    const out: string[] = [...imports]
    if (imports.length) out.push('')
    own.forEach((fn, i) => {
      if (i > 0) out.push('')
      fn.line = out.length + 1
      out.push(`export function ${fn.name}(x: number): number {`)
      calls.get(fn.name)!.forEach((callee, j) => {
        callSites.set(callee.name, [...(callSites.get(callee.name) ?? []), `${file}:${out.length + 1}`])
        out.push(`  const v${j} = ${tokenOf.get(callee.name)!}(x + ${j + 1})`)
      })
      const used = calls.get(fn.name)!.map((_, j) => ` + v${j}`).join('')
      out.push(`  return x * ${2 + Math.floor(next() * 90)}${used}`)
      out.push('}')
    })
    files[file] = `${out.join('\n')}\n`
  }

  for (const area of AREAS) {
    const lines = MODULE_WORDS[area].flatMap(module => {
      const own = modulesOf.get(`src/${area}/${module}.ts`)!
      const plain = `export { ${own.map(f => f.name).join(', ')} } from './${module}'`
      const renames = own.filter(f => renamed.has(f.name)).map(f => `export { ${f.name} as ${renamed.get(f.name)!} } from './${module}'`)
      return [plain, ...renames]
    })
    files[`src/${area}/index.ts`] = `${lines.join('\n')}\n`
  }

  const TEST_STYLES: ImportStyle[] = ['direct', 'direct', 'alias']
  for (const [file, own] of modulesOf) {
    if (next() < 0.5) continue
    const chosen = shuffle(own, next).slice(0, 1 + Math.floor(next() * 2))
    const testFile = file.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts')
    const { lines: imports, tokenOf } = importsFor(testFile, chosen, TEST_STYLES)
    const out = [`import { expect, test } from 'bun:test'`, ...imports, '']
    for (const fn of chosen) {
      testedBy.add(fn.name)
      out.push(`test('${fn.name}', () => {`, `  expect(${tokenOf.get(fn.name)!}(1)).toBeGreaterThan(0)`, '})', '')
    }
    files[testFile] = out.join('\n')
  }

  files['package.json'] = `${JSON.stringify({ name: `audit-fixture-${rep}`, private: true, type: 'module' }, null, 2)}\n`
  files['README.md'] =
    '# storefront\n\nFive areas under `src/`, each with an `index.ts` that re-exports its modules (and renames a few exports). Tests live in `test/`, one file per module that has any.\n'

  // Ten targets: eight with callers, at least four of those reached through another name, two with none.
  const byName = new Map(fns.map(f => [f.name, f]))
  const indirect = (name: string) => {
    const aliasTokens = new Set<string>()
    for (const [file, text] of Object.entries(files)) {
      if (!file.startsWith('src/') || file.endsWith('index.ts')) continue
      for (const m of text.matchAll(IMPORT_RE)) {
        for (const b of m[1]!.split(',').map(s => s.trim())) {
          const [exported, local] = b.split(/\s+as\s+/)
          if ((exported === name || renamed.get(name) === exported) && (local ?? exported) !== name) aliasTokens.add(local ?? exported!)
        }
      }
    }
    return aliasTokens.size > 0
  }
  const called = shuffle(fns.filter(f => callSites.has(f.name)), next)
  const viaOther = called.filter(f => indirect(f.name)).slice(0, 4)
  const rest = called.filter(f => !viaOther.includes(f)).slice(0, 8 - viaOther.length)
  const uncalled = shuffle(fns.filter(f => !callSites.has(f.name)), next).slice(0, TARGETS - viaOther.length - rest.length)
  const targets = shuffle([...viaOther, ...rest, ...uncalled], next).map(f => ({
    name: f.name,
    defined: `${f.file}:${byName.get(f.name)!.line}`,
    callers: [...(callSites.get(f.name) ?? [])].sort(),
    tested: testedBy.has(f.name),
  }))
  return { files, targets }
}

// ---------------------------------------------------------------------------
// The key, re-derived from the files — the dry run's check on the generator
// ---------------------------------------------------------------------------

const IMPORT_RE = /^import \{ ([^}]+) \} from '([^']+)'$/gm
const EXPORT_FN_RE = /^export function (\w+)\(/
const REEXPORT_RE = /^export \{ ([^}]+) \} from '\.\/(\w+)'$/

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === '.git') return []
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p, root) : [relative(root, p)]
  })
}

/** The module a specifier names from `fromFile`, as a project-relative path without `.ts`. */
function resolveSpec(fromFile: string, spec: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/**
 * What the files say about each target, derived without the generator: each
 * import resolved to the function it binds (through index.ts renames), each
 * line calling a bound name counted as a call site.
 */
export function observedTargets(dir: string, names: readonly string[]): Target[] {
  const files = walk(dir).filter(f => f.endsWith('.ts'))
  const text = new Map(files.map(f => [f, readFileSync(join(dir, f), 'utf8')]))
  // index.ts: exported name → the function it is
  const barrel = new Map<string, Map<string, string>>()
  for (const f of files.filter(f => f.endsWith('/index.ts'))) {
    const map = new Map<string, string>()
    for (const line of text.get(f)!.split('\n')) {
      const m = REEXPORT_RE.exec(line)
      if (!m) continue
      for (const b of m[1]!.split(',').map(s => s.trim())) {
        const [fn, as] = b.split(/\s+as\s+/)
        map.set(as ?? fn!, fn!)
      }
    }
    barrel.set(f.slice(0, -'/index.ts'.length), map)
  }
  const defined = new Map<string, string>()
  const callers = new Map<string, string[]>()
  const tested = new Set<string>()
  for (const f of files) {
    if (f.endsWith('/index.ts')) continue
    const lines = text.get(f)!.split('\n')
    const local = new Map<string, string>()
    for (const m of text.get(f)!.matchAll(IMPORT_RE)) {
      const target = resolveSpec(f, m[2]!)
      for (const b of m[1]!.split(',').map(s => s.trim())) {
        const [exported, as] = b.split(/\s+as\s+/)
        const fn = barrel.get(target)?.get(exported!) ?? exported!
        local.set(as ?? exported!, fn)
      }
    }
    lines.forEach((line, i) => {
      const def = EXPORT_FN_RE.exec(line)
      if (def) defined.set(def[1]!, `${f}:${i + 1}`)
      if (line.startsWith('import ')) return
      for (const [token, fn] of local) {
        if (!new RegExp(`\\b${token}\\(`).test(line)) continue
        if (f.startsWith('test/')) tested.add(fn)
        else callers.set(fn, [...(callers.get(fn) ?? []), `${f}:${i + 1}`])
      }
    })
  }
  return names.map(name => ({
    name,
    defined: defined.get(name) ?? '',
    callers: [...(callers.get(name) ?? [])].sort(),
    tested: tested.has(name),
  }))
}

// ---------------------------------------------------------------------------
// The audit and its grade
// ---------------------------------------------------------------------------

export function childPrompt(targets: readonly Target[]): string {
  return (
    `Audit these ${targets.length} functions of this TypeScript project: ${targets.map(t => t.name).join(', ')}. ` +
    'For each one, find where it is defined (the file:line of its export function), every line under src/ that calls it (file:line; some files import it under another name, or through an area index.ts that renames it), and whether any file under test/ calls it. ' +
    'Paths relative to the project root. Reply with one block per function: its name on a line of its own, then "defined: <file>:<line>", then "callers: <file>:<line>, <file>:<line>" (or "callers: none"), then "tested: yes" or "tested: no".'
  )
}

const SITE_RE = /(src\/[\w/.-]+\.ts):(\d+)/g
const DEFINED_LINE_RE = /defin/i
const TESTED_RE = /tested\W+(yes|no|true|false)\b/i
const WORD_CHAR_RE = /[\w$]/

export type TargetGrade = { name: string; defined: boolean; callers: boolean; tested: boolean }
export type AuditGrade = { score: number; max: number; targets: TargetGrade[] }

function mentions(text: string, word: string): number[] {
  const at: number[] = []
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!WORD_CHAR_RE.test(text.charAt(i - 1)) && !WORD_CHAR_RE.test(text.charAt(i + word.length))) at.push(i)
  }
  return at
}

function gradeStretch(stretch: string, t: Target): TargetGrade {
  const lines = stretch.split('\n')
  const definedLine = lines.find(l => DEFINED_LINE_RE.test(l))
  const definedSite = [...(definedLine ?? stretch).matchAll(SITE_RE)].map(m => `${m[1]}:${m[2]}`)[0]
  const sites = new Set([...stretch.matchAll(SITE_RE)].map(m => `${m[1]}:${m[2]}`))
  if (definedSite) sites.delete(definedSite)
  const tested = TESTED_RE.exec(stretch)?.[1]?.toLowerCase()
  return {
    name: t.name,
    defined: definedSite === t.defined,
    callers: sites.size === t.callers.length && t.callers.every(c => sites.has(c)),
    tested: tested !== undefined && (tested === 'yes' || tested === 'true') === t.tested,
  }
}

/**
 * Three points a target: its definition, the exact set of its call sites, and
 * whether it is tested. A target's stretch runs from a mention of its name to
 * the next mention of any target, and the best-scoring mention counts, so a
 * preamble naming them all does not hide the blocks below it.
 */
export function gradeAudit(text: string, targets: readonly Target[]): AuditGrade {
  const starts = targets.flatMap(t => mentions(text, t.name).map(at => ({ name: t.name, at }))).sort((a, b) => a.at - b.at)
  const graded = targets.map(t => {
    let best: TargetGrade = { name: t.name, defined: false, callers: false, tested: false }
    const points = (g: TargetGrade) => Number(g.defined) + Number(g.callers) + Number(g.tested)
    starts.forEach((s, i) => {
      if (s.name !== t.name) return
      const g = gradeStretch(text.slice(s.at + t.name.length, starts[i + 1]?.at ?? text.length), t)
      if (points(g) > points(best)) best = g
    })
    return best
  })
  const score = graded.reduce((n, g) => n + Number(g.defined) + Number(g.callers) + Number(g.tested), 0)
  return { score, max: targets.length * 3, targets: graded }
}

/** The reply a perfect audit gives, in the requested format. */
export function referenceReply(targets: readonly Target[]): string {
  return targets
    .map(t => `${t.name}\n  defined: ${t.defined}\n  callers: ${t.callers.length ? t.callers.join(', ') : 'none'}\n  tested: ${t.tested ? 'yes' : 'no'}`)
    .join('\n\n')
}
