// The fixture, answer key and grader of subagent-audit-ab.ts: a TypeScript
// project generated from a seed, and the call-chain trace a sub-agent is
// handed over it.
//
// The shape is the real corpus's: an audit sub-agent makes a median of 64
// calls, 69% of them with one tool, and in 5.8% of its calls a Read follows a
// Grep that found the file (team memory `request-count-levers-2026-09-24`,
// round 4). The first version of this fixture asked where ten functions were
// called from, and Opus answered it in three Greps: every call site was a
// greppable one-liner. So this one asks for what a search cannot batch — a
// hop whose target is only known once the previous body has been read:
//
//   - ten areas under src/, twelve modules each, six exported functions per
//     module, each 12-18 lines, too much to read whole;
//   - every body is a run of `acc = helper(acc, N)` lines calling the file's
//     own helpers (mixBits, foldBits, …, not exported), and at most ONE line
//     of the same shape calls an exported function of another module — so no
//     pattern tells the cross-module call from the helpers but its name;
//   - that name is the function's own, an alias from its import
//     (`import { loadLedger as safeLedger }`), or a name the other area's
//     index.ts re-exports it as (`export { loadLedger as ledgerLoad }`),
//     sometimes aliased again.
//
// The task names three functions, each the head of a chain of seven, and asks
// for every chain to its end with each function's definition. The generator
// writes every line itself, so the key is exact; `observedChains` re-derives
// it from the files, resolving the imports independently, and the dry run
// checks the two agree.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const AREAS = ['billing', 'catalog', 'orders', 'users', 'shipping', 'payments', 'reports', 'search', 'pricing', 'support'] as const
const MODULES_PER_AREA = 12
const MODULE_WORDS = [
  'ledger', 'invoice', 'refund', 'payout', 'tariff', 'voucher', 'receipt', 'credit', 'product', 'variant', 'stock', 'bundle',
  'category', 'supplier', 'barcode', 'cart', 'checkout', 'returns', 'basket', 'quote', 'backlog', 'dispatch', 'account', 'profile',
  'session', 'consent', 'address', 'loyalty', 'contact', 'avatar', 'parcel', 'carrier', 'route', 'customs', 'pallet', 'depot',
  'label', 'tracking', 'wallet', 'mandate', 'chargeback', 'settlement', 'digest', 'export', 'summary', 'metric', 'ranking', 'facet',
  'synonym', 'spelling', 'discount', 'margin', 'rebate', 'ticket', 'macro', 'escalation', 'survey', 'journal', 'batch', 'audit',
]
const FUNCTIONS_PER_MODULE = 6
const HELPERS = ['mixBits', 'foldBits', 'wrapBits', 'tiltBits', 'spinBits', 'packBits']
export const CHAINS = 3
export const CHAIN_LENGTH = 7

// verb + Noun: no verb ends another verb and no noun starts another noun, so
// no function name contains another. Aliases are adjective + Noun and index
// renames noun + Verb, so neither contains a function name either, and the
// helpers (…Bits) share no part with any of them.
const VERBS = ['load', 'parse', 'merge', 'split', 'score', 'flush', 'render', 'clamp', 'index', 'queue', 'trace', 'shift', 'fetch', 'build', 'sort', 'emit', 'drain', 'probe', 'guard', 'stamp', 'weigh', 'seal', 'sync', 'bind', 'fork', 'hash', 'lock', 'mark', 'pull', 'push']
const NOUNS = ['Ledger', 'Cursor', 'Bucket', 'Frame', 'Packet', 'Token', 'Window', 'Schema', 'Record', 'Vector', 'Socket', 'Header', 'Matrix', 'Buffer', 'Stream', 'Signal', 'Anchor', 'Handle', 'Filter', 'Kernel', 'Needle', 'Pocket', 'Quorum', 'Ribbon', 'Sheaf']
const ADJECTIVES = ['safe', 'raw', 'core', 'main', 'next', 'prev', 'soft', 'hard', 'cold', 'warm', 'wide', 'thin', 'deep', 'flat', 'bold', 'calm', 'dry', 'fair']

type ImportStyle = 'direct' | 'alias' | 'barrel' | 'barrelRename' | 'barrelRenameAlias'

export type Fn = { name: string; area: string; module: string; file: string; line: number }
export type ChainNode = { name: string; defined: string }
export type Chain = { start: string; nodes: ChainNode[] }
export type AuditFixture = { files: Record<string, string>; chains: Chain[] }

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
 * `module` is null. Same-area imports always name the module.
 */
function specifier(fromFile: string, area: string, module: string | null): string {
  if (fromFile.split('/')[1] === area) return `./${module}`
  return module ? `../${area}/${module}` : `../${area}`
}

/** Rep's project, and the chains a correct trace reports. */
export function auditFixture(rep: number): AuditFixture {
  const next = rng(rep)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
  const names = shuffle(VERBS.flatMap(v => NOUNS.map(n => v + n)), next)
  const aliases = shuffle(ADJECTIVES.flatMap(a => NOUNS.map(n => a + n)), next)
  let takenAlias = 0
  const nextAlias = (): string => {
    const alias = aliases[takenAlias++]
    if (!alias) throw new Error(`rep ${rep}: the alias pool ran out`)
    return alias
  }

  const fns: Fn[] = []
  const modulesOf = new Map<string, Fn[]>()
  const areaModules = new Map<string, string[]>()
  let taken = 0
  for (const area of AREAS) {
    // Module names are unique within an area; two areas may each have a ledger.ts.
    const mods = shuffle(MODULE_WORDS, next).slice(0, MODULES_PER_AREA)
    areaModules.set(area, mods)
    for (const module of mods) {
      const file = `src/${area}/${module}.ts`
      const own = names.slice(taken, taken + FUNCTIONS_PER_MODULE).map(name => ({ name, area, module, file, line: 0 }))
      taken += FUNCTIONS_PER_MODULE
      fns.push(...own)
      modulesOf.set(file, own)
    }
  }

  // Each area's index renames a fifth of its functions (noun + Verb).
  const renamed = new Map<string, string>()
  for (const fn of fns) {
    if (next() < 0.2) {
      const verb = VERBS.find(v => fn.name.startsWith(v))!
      renamed.set(fn.name, `${fn.name.slice(verb.length).toLowerCase()}${cap(verb)}`)
    }
  }

  // The chains: CHAINS × CHAIN_LENGTH functions, each from its own module.
  const callee = new Map<string, Fn | null>()
  const byModule = shuffle([...modulesOf.values()], next)
  const chainFns = byModule.slice(0, CHAINS * CHAIN_LENGTH).map(own => pick(own))
  const chainsOf: Fn[][] = Array.from({ length: CHAINS }, (_, c) => chainFns.slice(c * CHAIN_LENGTH, (c + 1) * CHAIN_LENGTH))
  for (const chain of chainsOf) chain.forEach((fn, i) => callee.set(fn.name, chain[i + 1] ?? null))
  // Everything else calls one function of another module, or none. Never a
  // chain head, so a chain is reached only from its own start.
  const heads = new Set(chainsOf.map(c => c[0]!.name))
  for (const fn of fns) {
    if (callee.has(fn.name)) continue
    callee.set(fn.name, next() < 0.6 ? pick(fns.filter(f => f.file !== fn.file && !heads.has(f.name))) : null)
  }

  const files: Record<string, string> = {}
  const SRC_STYLES: ImportStyle[] = ['direct', 'alias', 'barrel', 'barrelRename', 'barrelRenameAlias']
  for (const [file, own] of modulesOf) {
    // One import per callee, in the style drawn for it in this file.
    const tokenOf = new Map<string, string>()
    const bySource = new Map<string, string[]>()
    for (const fn of own) {
      const target = callee.get(fn.name)
      if (!target || tokenOf.has(target.name)) continue
      const sameArea = file.split('/')[1] === target.area
      let style = pick(SRC_STYLES)
      if (sameArea && style !== 'direct' && style !== 'alias') style = 'direct'
      if ((style === 'barrelRename' || style === 'barrelRenameAlias') && !renamed.has(target.name)) style = 'barrel'
      const spec = specifier(file, target.area, style === 'direct' || style === 'alias' ? target.module : null)
      let binding = target.name
      let token = target.name
      if (style === 'alias') {
        token = nextAlias()
        binding = `${target.name} as ${token}`
      } else if (style === 'barrelRename') {
        token = renamed.get(target.name)!
        binding = token
      } else if (style === 'barrelRenameAlias') {
        token = nextAlias()
        binding = `${renamed.get(target.name)!} as ${token}`
      }
      tokenOf.set(target.name, token)
      bySource.set(spec, [...(bySource.get(spec) ?? []), binding])
    }
    const out = [...bySource].sort(([x], [y]) => x.localeCompare(y)).map(([spec, bindings]) => `import { ${bindings.join(', ')} } from '${spec}'`)
    if (out.length) out.push('')
    for (const fn of own) {
      fn.line = out.length + 1
      out.push(`export function ${fn.name}(x: number, k: number): number {`, '  let acc = x + k')
      const steps = 10 + Math.floor(next() * 7)
      const target = callee.get(fn.name)
      const at = target ? Math.floor(next() * steps) : -1
      for (let s = 0; s < steps; s++) {
        const call = s === at ? tokenOf.get(target!.name)! : pick(HELPERS)
        out.push(`  acc = ${call}(acc, ${1 + Math.floor(next() * 97)})`)
      }
      out.push('  return acc', '}', '')
    }
    HELPERS.forEach((h, i) => out.push(`function ${h}(a: number, b: number): number {`, `  return (a * ${3 + i} + b) % 10007`, '}', ''))
    files[file] = out.join('\n')
  }

  for (const area of AREAS) {
    const lines = areaModules.get(area)!.flatMap(module => {
      const own = modulesOf.get(`src/${area}/${module}.ts`)!
      const plain = `export { ${own.map(f => f.name).join(', ')} } from './${module}'`
      const renames = own.filter(f => renamed.has(f.name)).map(f => `export { ${f.name} as ${renamed.get(f.name)!} } from './${module}'`)
      return [plain, ...renames]
    })
    files[`src/${area}/index.ts`] = `${lines.join('\n')}\n`
  }

  files['package.json'] = `${JSON.stringify({ name: `trace-fixture-${rep}`, private: true, type: 'module' }, null, 2)}\n`
  files['README.md'] =
    '# storefront\n\nTen areas under `src/`, each with an `index.ts` that re-exports its modules (and renames a few exports). Every module keeps its own `…Bits` helpers.\n'

  const chains = chainsOf.map(chain => ({
    start: chain[0]!.name,
    nodes: chain.map(fn => ({ name: fn.name, defined: `${fn.file}:${fn.line}` })),
  }))
  return { files, chains }
}

// ---------------------------------------------------------------------------
// The key, re-derived from the files — the dry run's check on the generator
// ---------------------------------------------------------------------------

const IMPORT_RE = /^import \{ ([^}]+) \} from '([^']+)'$/gm
const EXPORT_FN_RE = /^export function (\w+)\(/
const REEXPORT_RE = /^export \{ ([^}]+) \} from '\.\/([\w-]+)'$/

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
 * The chains the files hold, derived without the generator: each import
 * resolved to the function it binds (through index.ts renames), each exported
 * function's body searched for the bound names it calls, and each start
 * followed while its function calls exactly one.
 */
export function observedChains(dir: string, starts: readonly string[]): Chain[] {
  const files = walk(dir).filter(f => f.endsWith('.ts'))
  const text = new Map(files.map(f => [f, readFileSync(join(dir, f), 'utf8')]))
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
  const calls = new Map<string, string[]>()
  for (const f of files) {
    if (f.endsWith('/index.ts')) continue
    const src = text.get(f)!
    const local = new Map<string, string>()
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveSpec(f, m[2]!)
      for (const b of m[1]!.split(',').map(s => s.trim())) {
        const [exported, as] = b.split(/\s+as\s+/)
        local.set(as ?? exported!, barrel.get(target)?.get(exported!) ?? exported!)
      }
    }
    let current: string | null = null
    src.split('\n').forEach((line, i) => {
      const def = EXPORT_FN_RE.exec(line)
      if (def) {
        current = def[1]!
        defined.set(current, `${f}:${i + 1}`)
        calls.set(current, [])
        return
      }
      if (line === '}') current = null
      if (!current) return
      for (const [token, fn] of local) if (new RegExp(`\\b${token}\\(`).test(line)) calls.get(current)!.push(fn)
    })
  }
  return starts.map(start => {
    const nodes: ChainNode[] = []
    const seen = new Set<string>()
    for (let name: string | undefined = start; name !== undefined && !seen.has(name); ) {
      seen.add(name)
      nodes.push({ name, defined: defined.get(name) ?? '' })
      const out: string[] = calls.get(name) ?? []
      name = out.length === 1 ? out[0] : undefined
    }
    return { start, nodes }
  })
}

// ---------------------------------------------------------------------------
// The task and its grade
// ---------------------------------------------------------------------------

export function childPrompt(chains: readonly Chain[]): string {
  return (
    `Trace ${chains.length} call chains in this TypeScript project, starting at ${chains.map(c => c.start).join(', ')}. ` +
    'Every exported function calls at most one exported function of another module — sometimes under a name it imported with `as`, or under a name an area index.ts re-exports it as — among calls to its own file\'s …Bits helpers, which do not count. ' +
    'From each start, follow the call to the function it calls, then the one that one calls, and so on, until a function that calls no other exported function. ' +
    "Reply with one line per chain: every function in the chain by its real exported name, each followed by the file:line of its `export function` line, joined by ' -> ', starting with the start function. Paths relative to the project root."
  )
}

/** `name file:line`, the separator a few punctuation marks or a word like "at". */
const ENTRY_RE = /([A-Za-z_$][\w$]*)(?:\W{0,4}|\s+(?:at|in|@)\s+)(src\/[\w/.-]+\.ts):(\d+)/g
const WORD_CHAR_RE = /[\w$]/

export type ChainGrade = { start: string; points: number; max: number }
export type AuditGrade = { score: number; max: number; chains: ChainGrade[] }

function mentions(text: string, word: string): number[] {
  const at: number[] = []
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!WORD_CHAR_RE.test(text.charAt(i - 1)) && !WORD_CHAR_RE.test(text.charAt(i + word.length))) at.push(i)
  }
  return at
}

/** One point per chain function reported at its position with its definition. */
function pointsIn(stretch: string, chain: Chain): number {
  const entries = [...stretch.matchAll(ENTRY_RE)].map(m => ({ name: m[1]!, site: `${m[2]}:${m[3]}` }))
  // A reply may name the start as a header and list the rest.
  const offset = entries[0]?.name === chain.start ? 0 : 1
  let points = 0
  chain.nodes.forEach((node, i) => {
    const e = entries[i - offset]
    if (e && e.name === node.name && e.site === node.defined) points++
  })
  return points
}

/**
 * A chain's stretch runs from a mention of its start to the next mention of
 * another start, and the best-scoring mention counts, so a preamble naming
 * every start does not hide the lines below it.
 */
export function gradeAudit(text: string, chains: readonly Chain[]): AuditGrade {
  const starts = chains.flatMap(c => mentions(text, c.start).map(at => ({ start: c.start, at }))).sort((a, b) => a.at - b.at)
  const graded = chains.map(c => {
    let best = 0
    starts.forEach((s, i) => {
      if (s.start !== c.start) return
      const nextOther = starts.slice(i + 1).find(o => o.start !== c.start)?.at ?? text.length
      best = Math.max(best, pointsIn(text.slice(s.at, nextOther), c))
    })
    return { start: c.start, points: best, max: c.nodes.length }
  })
  return { score: graded.reduce((n, g) => n + g.points, 0), max: graded.reduce((n, g) => n + g.max, 0), chains: graded }
}

/** The reply a perfect trace gives, in the requested format. */
export function referenceReply(chains: readonly Chain[]): string {
  return chains.map(c => c.nodes.map(n => `${n.name} ${n.defined}`).join(' -> ')).join('\n')
}
