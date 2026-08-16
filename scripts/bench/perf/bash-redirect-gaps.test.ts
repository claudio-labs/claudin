// Corpus scan: every Bash call that READS OR SEARCHES files, and whether the
// Bash→Read/Grep/Glob redirect converts it.
//
// The premise is the redirect's own, inverted: Bash is the alternative path, so
// a read/search command that does NOT redirect is a report about the tools —
// either a capability Grep/Glob do not have, or a shape the mapper cannot
// express. This turns that into a queue, replacing the hand-run probe that
// produced the last round of fixes (one session, six commands, four of them
// capability gaps).
//
// What it cannot do is attribute causes exactly: the reasons live inside
// parseGrep/parseFind as early returns, not as a value. So the VERDICT comes
// from the real analyzer and the REASON is a best-effort probe, printed with
// samples for a human to triage.
//
// TWO corpora, reported apart:
//   - ~/.claudin/projects — this fork's own sessions. The redirect ran here, so
//     a shape that converts stopped being written in Bash: these counts are the
//     RESIDUE, and a gap measured on them is a floor.
//   - ~/.claude/projects — Claude Code, which has no Bash→tool redirect, so its
//     command mix is the natural distribution. Nothing here was ever refused.
// Only the first is comparable to the reach numbers recorded on 2026-08-16.
//
// Two sources of false "does not redirect", both reported rather than hidden:
//   - the session's cwd no longer exists (a deleted checkout), which fails
//     every path check — counted separately and excluded;
//   - the cwd exists but the FILE the command named is gone, which is
//     indistinguishable here from a command the mapper refused. Read a small
//     `unclassified` bucket as noise of that kind.
//
// Implemented as a bun test rather than a plain script for the same reason as
// bash-filter-gain.test.ts: bunfig.toml's `[test]` preload is what stubs the
// modules this fork never received, and the analyzer's import chain reaches one
// of them (`@anthropic-ai/sandbox-runtime`, via permissions/pathValidation).
// `bun run` does not apply that preload and cannot load the analyzer at all.
//
// Default behaviour: skipped on `bun test`. Run explicitly with:
//   CLAUDIN_BENCH=1 bun test scripts/bench/perf/bash-redirect-gaps.test.ts

import { describe, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import {
  walkCommandSegments,
  type CommandSegment,
} from '../../../src/platform/bash/segments.js'
import { tryParseShellCommand } from '../../../src/platform/bash/shellQuote.js'
import { breToEre } from '../../../src/tools/BashTool/breToEre.js'
import {
  analyzeCommandForRedirect,
  type RedirectUnit,
} from '../../../src/tools/BashTool/toolRedirect.js'

const CORPORA: { label: string; root: string }[] = [
  { label: 'claudin', root: `${process.env.HOME}/.claudin/projects` },
  { label: 'claude-code', root: `${process.env.HOME}/.claude/projects` },
]
const SAMPLES_PER_REASON = 4
const SAMPLES_PER_ARM = 8

/** The command families the redirect's prompt line tells the model to avoid. */
const READ_SEARCH_HEAD_RE =
  /^\s*(cat|head|tail|nl|sed|awk|grep|egrep|rg|find|ls|wc)\b/

type Reason = { label: string; test: (command: string) => boolean }

const GREP_PATTERN_RE = /\be?grep\b[^|]*?\s(?:"([^"]*)"|'([^']*)')/

function hasUntranslatableBre(command: string): boolean {
  if (/\be?grep\b[^|]*\s-[A-Za-z]*E/.test(command)) return false // -E is ERE
  if (/(^|\|)\s*rg\b/.test(command)) return false
  const m = GREP_PATTERN_RE.exec(command)
  const pattern = m?.[1] ?? m?.[2]
  if (pattern === undefined || pattern === '') return false
  return breToEre(pattern) === null
}

const STDERR_DISCARD_RE = /(?:^|\s)2>\s*\/dev\/null(?=\s|$)/
const CD_PREFIX_RE = /^\s*cd\s+[^&|;]+&&/

/**
 * Ordered: the first match wins, so the deliberate carve-outs come before the
 * gaps that would otherwise absorb them.
 */
const REASONS: Reason[] = [
  {
    label: 'expansion ($VAR or $(…))',
    test: c => /\$\(|\$\{|\$[A-Za-z_]/.test(c),
  },
  {
    label: 'ls — deliberate, Read’s prompt sends it here',
    test: c => /(^|\|)\s*ls\b/.test(c),
  },
  {
    label: 'tail — deliberate, no Read spelling',
    test: c => /(^|\|)\s*tail\b/.test(c),
  },
  {
    label: 'awk — deliberate, would need reading the program',
    test: c => /(^|\|)\s*awk\b/.test(c),
  },
  { label: 'wc — a count no tool returns', test: c => /(^|\|)\s*wc\b/.test(c) },
  { label: 'sed edit (-i or s///)', test: c => /sed\s+(-i|.*\bs\/)/.test(c) },
  {
    label: 'find predicate with no Glob spelling',
    test: c =>
      /\bfind\b.*(-maxdepth|-mindepth|-type\s+[^f]|-o\b|-path|-exec|-delete|-newer|-size|-mtime)/.test(
        c,
      ),
  },
  {
    label: 'a windowed source piped into grep (line range)',
    // Anchored at the pipeline HEAD on purpose: an unanchored `head` also
    // matches the `| head -20` that folds into head_limit and redirects fine,
    // which mislabelled 228 rows on the first run.
    test: c => /^\s*(sed\s+-n|head)\b[^|]*\|\s*e?grep\b/.test(c),
  },
  {
    label: 'grep piped into grep',
    test: c => /\be?grep\b[^|]*\|\s*e?grep\b/.test(c),
  },
  {
    label: 'grep flag with no Grep spelling',
    test: c => /\be?grep\b[^|]*\s-[A-Za-z]*[voPwFmzq]/.test(c),
  },
  {
    label: 'BRE pattern that cannot be translated',
    test: hasUntranslatableBre,
  },
  {
    label: 'piped into a shell filter (sort, uniq, jq, xargs…)',
    test: c => /\|\s*(sort|uniq|jq|xargs|tr|cut|column|less)\b/.test(c),
  },
  // The four below replace one `redirection or a shell operator` bucket that
  // held 813 rows and named no fix. Ordered most-specific first.
  { label: 'stderr discarded (2>/dev/null)', test: c => STDERR_DISCARD_RE.test(c) },
  { label: 'cd <dir> && … (path rebase)', test: c => CD_PREFIX_RE.test(c) },
  { label: 'redirection (a write, or an fd other than the above)', test: c => /[><]/.test(c) },
  { label: 'a shell operator (&& or ||)', test: c => /&&|\|\|/.test(c) },
]

function reasonFor(command: string): string {
  for (const { label, test: matches } of REASONS) {
    try {
      if (matches(command)) return label
    } catch {
      // A probe is a heuristic; one throwing must not drop the row.
    }
  }
  return 'unclassified'
}

// --- Sizing the candidate arms ---------------------------------------------
//
// The reason buckets above are a triage heuristic. These are not: each arm is
// sized by REWRITING the command into the shape that arm would produce and
// asking the REAL analyzer whether that shape redirects. So the number is
// "rows this arm would actually convert", not "rows that look like it".
//
// The arms overlap (`cd D && grep … 2>/dev/null` is two of them), so the counts
// do not sum to a total.

const STDERR_DISCARD_GLOBAL_RE = /(?:^|\s)2>\s*\/dev\/null(?=\s|$)/g
const CD_SPLIT_RE = /^\s*cd\s+([^&|;]+?)\s*&&\s*([\s\S]+)$/
const SHELL_SAFE_RE = /^[\w./*@:=+-]+$/
const GREP_HEADS: ReadonlySet<string> = new Set(['grep', 'egrep', 'rg'])
const FIND_HEADS: ReadonlySet<string> = new Set(['find'])

/** Flags that consume the NEXT argv entry, which is therefore not a path. */
const GREP_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
  '-A', '-B', '-C', '-m', '-e', '-f', '-d', '-g', '-t',
  '--after-context', '--before-context', '--context', '--max-count',
  '--regexp', '--file', '--include', '--exclude', '--exclude-dir',
  '--glob', '--type',
])

/** One segment's text → argv, glob tokens flattened the way argvOf does. */
function argvOfText(text: string): string[] | null {
  const parsed = tryParseShellCommand(text, name => `$${name}`)
  if (!parsed.success) return null
  const argv: string[] = []
  for (const token of parsed.tokens) {
    if (typeof token === 'string') {
      argv.push(token)
    } else if (
      token !== null &&
      typeof token === 'object' &&
      'op' in token &&
      token.op === 'glob' &&
      'pattern' in token
    ) {
      argv.push(String(token.pattern))
    } else {
      return null
    }
  }
  return argv.length > 0 ? argv : null
}

function argvOfSingleSegment(
  command: string,
  heads: ReadonlySet<string>,
): string[] | null {
  const walked = walkCommandSegments(command)
  if (!walked || walked.hasOutputRedirection) return null
  if (walked.segments.length !== 1) return null
  const segment = walked.segments[0]!
  if (!heads.has(segment.name)) return null
  return argvOfText(segment.text)
}

function requote(argv: string[]): string {
  return argv
    .map(arg =>
      SHELL_SAFE_RE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ')
}

/** Positional arguments of a grep argv, i.e. the pattern and its paths. */
function grepPositionals(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-') && arg !== '-') {
      if (!arg.includes('=') && GREP_FLAGS_WITH_ARG.has(arg)) i++
      continue
    }
    out.push(arg)
  }
  return out
}

/** The same grep, keeping only the FIRST path — what one of the N calls is. */
function withFirstPathOnly(argv: string[]): string[] {
  const out: string[] = [argv[0]!]
  let positionals = 0
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-') && arg !== '-') {
      out.push(arg)
      if (!arg.includes('=') && GREP_FLAGS_WITH_ARG.has(arg)) {
        const value = argv[++i]
        if (value !== undefined) out.push(value)
      }
      continue
    }
    positionals++
    if (positionals <= 2) out.push(arg)
  }
  return out
}

function convertsUnderStderrArm(row: Row): boolean {
  if (!STDERR_DISCARD_RE.test(row.command)) return false
  const stripped = row.command.replace(STDERR_DISCARD_GLOBAL_RE, ' ').trim()
  return analyzeCommandForRedirect(stripped, row.cwd) !== null
}

function convertsUnderMultiPathArm(row: Row): boolean {
  const command = row.command.replace(STDERR_DISCARD_GLOBAL_RE, ' ').trim()
  const argv = argvOfSingleSegment(command, GREP_HEADS)
  if (!argv) return false
  // pattern + 2 paths at minimum.
  if (grepPositionals(argv).length < 3) return false
  return (
    analyzeCommandForRedirect(requote(withFirstPathOnly(argv)), row.cwd) !== null
  )
}

function convertsUnderFindAlternationArm(row: Row): boolean {
  const argv = argvOfSingleSegment(row.command, FIND_HEADS)
  if (!argv) return false
  const alternation = argv.indexOf('-o')
  if (alternation === -1) return false
  return (
    analyzeCommandForRedirect(requote(argv.slice(0, alternation)), row.cwd) !==
    null
  )
}

function convertsUnderCdRebaseArm(row: Row): boolean {
  const match = CD_SPLIT_RE.exec(row.command)
  if (!match) return false
  const dir = match[1]!.replace(/^['"]|['"]$/g, '')
  const base = isAbsolute(dir) ? dir : join(row.cwd, dir)
  if (!existsSync(base)) return false
  return analyzeCommandForRedirect(match[2]!, base) !== null
}

const ARMS: { label: string; converts: (row: Row) => boolean }[] = [
  { label: 'grep with 2+ paths → N Grep calls', converts: convertsUnderMultiPathArm },
  { label: '2>/dev/null treated as a discard', converts: convertsUnderStderrArm },
  { label: 'find -name A -o -name B → one Glob', converts: convertsUnderFindAlternationArm },
  { label: 'cd D && <one command> (out of scope, sized anyway)', converts: convertsUnderCdRebaseArm },
]

// --- find: the shapes, and the arms that would close them -------------------
//
// `find` converts worse than anything else the redirect covers — 11.2% against
// a 17% average — because parseFind accepts one `-name`/`-iname`, `-type f` and
// a single root, and everything else is an early return. The histogram below
// says which predicates the corpus actually carries; the arms say how many
// commands each one would CONVERT, which is a different and much smaller
// number: `-o` appeared 109 times and converted 3, the rest of those commands
// being stood down by a `| head` or a `-type d` anyway.
//
// Every arm here rewrites the command into the shape the arm would produce and
// asks the real analyzer. Two numbers per arm, because the arms OVERLAP heavily
// (`find … -maxdepth 2 -type f | sort` is three of them at once):
//
//   isolated — what the arm converts on its own, i.e. what shipping only it buys
//              today. This is what the first run measured, and it under-reports
//              every arm whose commands carry a second unsupported shape.
//   marginal — leave-one-out: converted with ALL arms minus converted with all
//              but this one. What the arm is worth GIVEN the others ship too.
//
// The union (`ALL`) is the ceiling for the whole round. Re-running after a
// promotion re-sizes what is left, since a shipped arm stops being an arm and
// starts being part of the analyzer's own answer.

/** Predicates the histogram knows how to name; anything else is `other`. */
const FIND_PREDICATES: ReadonlySet<string> = new Set([
  '-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-ipath',
  '-regex', '-iregex', '-exec', '-execdir', '-delete', '-newer', '-newermt',
  '-mtime', '-mmin', '-size', '-empty', '-not', '!', '-o', '-or', '-a', '-and',
  '-prune', '-print', '-print0', '-follow', '-user', '-group', '-perm', '-links',
  '-depth', '-readable', '-writable', '-executable',
])

type FindRow = { row: Row; argv: string[]; tail: CommandSegment[] }
/** A find command taken apart: its argv, and the pipeline hanging off it. */
type FindShape = { argv: string[]; tail: CommandSegment[] }

/** A pipeline whose HEAD is `find` and whose joins are all `|`. */
function asFindShape(row: Row): FindShape | null {
  const walked = walkCommandSegments(row.command)
  if (!walked || walked.hasOutputRedirection) return null
  const [head, ...tail] = walked.segments
  if (!head || head.name !== 'find') return null
  if (tail.some(segment => segment.joinedBy !== '|')) return null
  const argv = argvOfText(head.text)
  return argv ? { argv, tail } : null
}

/** Positional roots, which in find come before the first predicate. */
function leadingRoots(argv: string[]): string[] {
  const roots: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-') || arg === '!') break
    roots.push(arg)
  }
  return roots
}

/** `head -20`, `head -n 20`, bare `head` (10) → the count, or null. */
function headCount(text: string): number | null {
  const argv = argvOfText(text)
  if (!argv || argv[0] !== 'head') return null
  if (argv.length === 1) return 10
  const joined = argv.slice(1)
  if (joined.length === 1 && /^-\d+$/.test(joined[0]!)) {
    return Number(joined[0]!.slice(1))
  }
  if (joined.length === 2 && (joined[0] === '-n' || joined[0] === '--lines')) {
    return /^\d+$/.test(joined[1]!) ? Number(joined[1]) : null
  }
  return null
}

/** A bare `sort` — any flag changes what it produces, so any flag stands down. */
function isBareSort(segment: CommandSegment): boolean {
  const argv = argvOfText(segment.text)
  return argv !== null && argv.length === 1 && argv[0] === 'sort'
}

const XARGS_FLAGS_NO_ARG: ReadonlySet<string> = new Set([
  '-0', '-r', '-t', '--null', '--no-run-if-empty', '--verbose',
])
const XARGS_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
  '-n', '-P', '-I', '-L', '-a', '-d', '-s', '--max-args', '--max-procs',
  '--replace', '--delimiter',
])

/** The grep invocation an `xargs …` segment runs, or null. */
function grepAfterXargs(segment: CommandSegment): string[] | null {
  const argv = argvOfText(segment.text)
  if (!argv || argv[0] !== 'xargs') return null
  let i = 1
  while (i < argv.length) {
    const arg = argv[i]!
    if (!arg.startsWith('-')) break
    if (XARGS_FLAGS_NO_ARG.has(arg)) {
      i += 1
      continue
    }
    if (XARGS_FLAGS_WITH_ARG.has(arg)) {
      i += 2
      continue
    }
    // `-n1`, `-I{}` — the value glued to a single-letter flag.
    if (/^-[nPILads].+/.test(arg)) {
      i += 1
      continue
    }
    return null
  }
  const rest = argv.slice(i)
  return GREP_HEADS.has(rest[0] ?? '') ? rest : null
}

/** The grep invocation a `-exec grep … {}` carries, or null. */
function grepAfterExec(argv: string[]): string[] | null {
  const at = argv.indexOf('-exec')
  if (at === -1) return null
  const rest = argv.slice(at + 1)
  const brace = rest.indexOf('{}')
  if (brace === -1) return null
  const grepArgv = rest.slice(0, brace)
  return GREP_HEADS.has(grepArgv[0] ?? '') ? grepArgv : null
}

/**
 * The file SET a find describes, when it is one Grep can express: a root, an
 * optional `-name` (which becomes `--include`) and `-type f`. `-iname` is out —
 * `--include` has no case-insensitive form.
 */
function findFileSet(argv: string[]): { root: string; include?: string } | null {
  let root: string | undefined
  let include: string | undefined
  let sawTypeFile = false
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-exec') break // the caller owns everything past it
    if (!arg.startsWith('-')) {
      if (root !== undefined || include !== undefined) return null
      root = arg
      continue
    }
    switch (arg) {
      case '-name': {
        const value = argv[++i]
        if (value === undefined || include !== undefined) return null
        include = value
        break
      }
      case '-type': {
        if (argv[++i] !== 'f') return null
        sawTypeFile = true
        break
      }
      case '-print':
      case '-print0':
        break
      default:
        return null
    }
  }
  if (include === undefined && !sawTypeFile) return null
  return { root: root ?? '.', include }
}

/** `find R -name P | xargs grep PAT` → the `grep -r --include=P PAT R` it is. */
function grepOverFindSet(shape: FindShape, grepArgv: string[]): string | null {
  const set = findFileSet(shape.argv)
  if (!set) return null
  // A placeholder means the command names its own paths; nothing to rewrite.
  if (grepArgv.some(arg => arg === '{}' || arg === ';' || arg === '+')) {
    return null
  }
  const [head, ...rest] = grepArgv
  const out = [head!, '-r', ...rest]
  if (set.include !== undefined) out.push(`--include=${set.include}`)
  out.push(set.root)
  return requote(out)
}

/**
 * Arm A is not a predicate the shape can lose, it REPLACES the whole command:
 * the find describes a file set and the grep behind it is the search. Runs
 * after the shape transforms, so a `-maxdepth` this round also removes no
 * longer hides the xargs behind it.
 */
function asGrepOverFindSet(shape: FindShape): string | null {
  if (shape.tail.length === 0) {
    const grepArgv = grepAfterExec(shape.argv)
    return grepArgv ? grepOverFindSet(shape, grepArgv) : null
  }
  if (shape.tail.length !== 1) return null
  const grepArgv = grepAfterXargs(shape.tail[0]!)
  return grepArgv ? grepOverFindSet(shape, grepArgv) : null
}

type FindArm = {
  id: string
  label: string
  /**
   * The shape as if this arm existed, or null when the arm does not apply.
   * Applied to a fixpoint, so it MUST stop applying to its own output.
   */
  apply: (shape: FindShape) => FindShape | null
}

const FIND_ARMS: FindArm[] = [
  {
    id: 'A',
    label: 'A  find … | xargs grep / -exec grep → one Grep',
    // Handled by asGrepOverFindSet at render time, not as a shape transform.
    apply: () => null,
  },
  {
    id: 'B',
    label: 'B  -maxdepth N → Glob(max_depth)',
    apply: ({ argv, tail }) => {
      const at = argv.indexOf('-maxdepth')
      if (at === -1) return null
      const depth = Number(argv[at + 1])
      if (!Number.isInteger(depth) || depth < 1) return null
      return { argv: [...argv.slice(0, at), ...argv.slice(at + 2)], tail }
    },
  },
  {
    id: 'C',
    label: 'C  -type d → Glob(type:"dir")',
    apply: ({ argv, tail }) => {
      const at = argv.indexOf('-type')
      if (at === -1 || argv[at + 1] !== 'd') return null
      // `-type f` is the shape parseFind already accepts, so asking about it
      // measures exactly what a `dir` spelling would add.
      return {
        argv: [...argv.slice(0, at), '-type', 'f', ...argv.slice(at + 2)],
        tail,
      }
    },
  },
  {
    id: 'D',
    label: 'D  find … | head -N (N ≤ 50) → Glob(head_limit)',
    apply: ({ argv, tail }) => {
      const last = tail[tail.length - 1]
      if (!last) return null
      const count = headCount(last.text)
      // Above 50 the summarizer trims the listing anyway, so folding would
      // promise more paths than the model receives.
      if (count === null || count > 50) return null
      return { argv, tail: tail.slice(0, -1) }
    },
  },
  {
    id: 'E',
    label: 'E  find … | sort [| head -N] → Glob(sort:"path")',
    apply: ({ argv, tail }) => {
      const last = tail[tail.length - 1]
      // Only a TRAILING sort reorders what the pipeline returns; a `sort` with
      // anything after it is feeding something else.
      if (!last || !isBareSort(last)) return null
      return { argv, tail: tail.slice(0, -1) }
    },
  },
  {
    id: 'F',
    label: 'F  -not -path X → Glob(exclude)',
    apply: ({ argv, tail }) => {
      for (const negation of ['-not', '!']) {
        const at = argv.indexOf(negation)
        if (at !== -1 && argv[at + 1] === '-path') {
          return { argv: [...argv.slice(0, at), ...argv.slice(at + 3)], tail }
        }
      }
      return null
    },
  },
  {
    id: 'G',
    label: 'G  -path / -regex → a Glob pattern (UPPER BOUND: drops it)',
    apply: ({ argv, tail }) => {
      const at = argv.findIndex(
        arg => arg === '-path' || arg === '-ipath' || arg === '-regex',
      )
      if (at === -1) return null
      const before = argv[at - 1]
      if (before === '-not' || before === '!') return null // that is arm F
      return { argv: [...argv.slice(0, at), ...argv.slice(at + 2)], tail }
    },
  },
  {
    id: 'H',
    label: 'H  find A B -name P → N Globs',
    apply: ({ argv, tail }) => {
      const roots = leadingRoots(argv)
      if (roots.length < 2) return null
      return {
        argv: [argv[0]!, roots[0]!, ...argv.slice(1 + roots.length)],
        tail,
      }
    },
  },
  {
    id: 'I',
    label: 'I  find … | grep PAT → a narrower Glob (UPPER BOUND: drops it)',
    apply: ({ argv, tail }) => {
      const last = tail[tail.length - 1]
      if (!last || !GREP_HEADS.has(last.name)) return null
      // `find … | grep PAT` filters the WHOLE path by regex; a Glob pattern
      // matches the basename, so this is an upper bound on a shape that has no
      // faithful spelling, not an arm anyone would build.
      return { argv, tail: tail.slice(0, -1) }
    },
  },
]

function renderShape(shape: FindShape): string {
  return [requote(shape.argv), ...shape.tail.map(segment => segment.text)].join(
    ' | ',
  )
}

/**
 * The arms with a faithful spelling behind them. G and I are sized to have the
 * number, not to be built: find's `-path` and a `| grep` over the path list
 * both match across `/`, where a Glob pattern matches one segment — dropping
 * them measures an upper bound on a shape that would silently return more than
 * the command asked for.
 */
const BUILDABLE_ARMS = FIND_ARMS.filter(arm => !arm.label.includes('UPPER BOUND'))

/** Does the row convert once every arm in `arms` exists? */
function convertsWith(row: Row, arms: FindArm[]): boolean {
  const start = asFindShape(row)
  if (!start) return false
  let shape = start
  // Fixpoint rather than one pass: `| sort | head -5` needs D then E, and a
  // second `-not -path` needs F twice.
  for (let round = 0; round < 8; round++) {
    let changed = false
    for (const arm of arms) {
      const next = arm.apply(shape)
      if (next) {
        shape = next
        changed = true
      }
    }
    if (!changed) break
  }
  const commands: string[] = []
  if (arms.some(arm => arm.id === 'A')) {
    const asGrep = asGrepOverFindSet(shape)
    if (asGrep !== null) commands.push(asGrep)
  }
  commands.push(renderShape(shape))
  return commands.some(command => {
    try {
      return analyzeCommandForRedirect(command, row.cwd) !== null
    } catch {
      return false
    }
  })
}

// --- Corpus scan ------------------------------------------------------------

type Row = { command: string; cwd: string; units?: RedirectUnit[] }

type Scan = {
  label: string
  root: string
  sessions: number
  bashCalls: number
  staleCwd: number
  redirected: Row[]
  notRedirected: Row[]
}

function sessionFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) walk(full)
      else if (entry.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root)
  return out
}

function scanCorpus(label: string, root: string): Scan {
  const scan: Scan = {
    label,
    root,
    sessions: 0,
    bashCalls: 0,
    staleCwd: 0,
    redirected: [],
    notRedirected: [],
  }

  for (const file of sessionFiles(root)) {
    scan.sessions++
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"Bash"')) continue
      let entry: {
        cwd?: unknown
        message?: { content?: unknown }
      }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
      for (const block of content as {
        type?: string
        name?: string
        input?: { command?: unknown }
      }[]) {
        if (block?.type !== 'tool_use' || block.name !== 'Bash') continue
        const command = block.input?.command
        if (typeof command !== 'string') continue
        scan.bashCalls++
        if (!READ_SEARCH_HEAD_RE.test(command)) continue
        if (!cwd || !existsSync(cwd)) {
          scan.staleCwd++
          continue
        }
        let analysis = null
        try {
          analysis = analyzeCommandForRedirect(command, cwd)
        } catch {
          // The analyzer stats paths; an unreadable one is not a finding.
        }
        if (analysis) {
          scan.redirected.push({ command, cwd, units: analysis.units })
        } else {
          scan.notRedirected.push({ command, cwd })
        }
      }
    }
  }
  return scan
}

// --- Report -----------------------------------------------------------------

const pct = (n: number, of: number): string =>
  of === 0 ? '—' : `${((n / of) * 100).toFixed(1)}%`

function oneLine(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat
}

/** Commands, deduped, most frequent first — the fixture source for a promotion. */
function deduped(rows: Row[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = oneLine(row.command)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

function reportHeadline(scan: Scan): number {
  const considered = scan.redirected.length + scan.notRedirected.length
  console.log(`\n${'='.repeat(72)}`)
  console.log(`corpus ${scan.label}  (${scan.root})`)
  console.log('='.repeat(72))
  console.log(`sessions scanned      ${scan.sessions}`)
  console.log(`Bash calls            ${scan.bashCalls}`)
  console.log(
    `read/search calls     ${considered}  (${pct(considered, scan.bashCalls)} of Bash)`,
  )
  console.log(`  skipped, stale cwd  ${scan.staleCwd}`)
  console.log(
    `  redirected          ${scan.redirected.length}  (${pct(scan.redirected.length, considered)})`,
  )
  console.log(
    `  ran in the shell    ${scan.notRedirected.length}  (${pct(scan.notRedirected.length, considered)})`,
  )
  return considered
}

/**
 * Which of the redirects only exist because of the arms added in an earlier
 * round — the honest way to size them without replaying an old build.
 * COMMANDS, not calls. One command can produce several Grep calls, and counting
 * those would inflate an arm's credit by however many paths it happened to name.
 */
function reportShippedArms(scan: Scan): void {
  let viaTranslation = 0
  let viaIname = 0
  let viaFilter = 0
  let viaSeveralPaths = 0
  for (const row of scan.redirected) {
    const units = row.units ?? []
    const calls = units.flatMap(unit => unit.calls)
    if (calls.some(call => call.tool === 'Grep' && call.translated)) {
      viaTranslation++
    }
    if (calls.some(call => call.tool === 'Glob' && call.caseInsensitive)) {
      viaIname++
    }
    if (
      units.some(
        unit =>
          unit.text.includes('|') &&
          unit.calls.length === 1 &&
          unit.calls[0]?.tool === 'Grep' &&
          /\|\s*e?grep\b/.test(unit.text),
      )
    ) {
      viaFilter++
    }
    if (units.some(unit => unit.calls.length > 1)) viaSeveralPaths++
  }
  console.log(`\nRedirects owed to the arms already shipped:`)
  console.log(`  BRE pattern translated   ${viaTranslation}`)
  console.log(`  find -iname → Glob -i    ${viaIname}`)
  console.log(`  source | grep folded     ${viaFilter}`)
  console.log(`  several paths → N calls  ${viaSeveralPaths}`)
}

function reportGeneralArms(scan: Scan, considered: number): void {
  console.log(
    '\nWhat each candidate arm would convert (real analyzer, rewritten shape):\n',
  )
  const converted = new Set<Row>()
  for (const { label, converts } of ARMS) {
    const hits: Row[] = []
    for (const row of scan.notRedirected) {
      try {
        if (converts(row)) hits.push(row)
      } catch {
        // A sizing probe is best-effort; one throwing must not drop the run.
      }
    }
    for (const row of hits) converted.add(row)
    console.log(`${String(hits.length).padStart(5)}  ${label}`)
    for (const row of hits.slice(0, SAMPLES_PER_REASON)) {
      console.log(`       ${oneLine(row.command)}`)
    }
  }
  // The arms overlap, so this is the number that matters, not their sum.
  console.log(
    `${String(converted.size).padStart(5)}  = union, i.e. reach ${scan.redirected.length} → ${
      scan.redirected.length + converted.size
    } (${pct(scan.redirected.length + converted.size, considered)} of read/search calls)`,
  )
}

function reportFind(scan: Scan): void {
  const findRows = [...scan.redirected, ...scan.notRedirected].filter(row =>
    /^\s*find\b/.test(row.command),
  )
  const findConverted = findRows.filter(row => row.units !== undefined)
  const findShell = findRows.filter(row => row.units === undefined)

  console.log(`\n${'-'.repeat(72)}`)
  console.log(
    `find rows             ${findRows.length}  (${findConverted.length} convert, ${pct(findConverted.length, findRows.length)})`,
  )
  console.log('-'.repeat(72))

  // Occurrence, multi-labelled: one command carrying `-maxdepth` and `-type d`
  // is counted by both. Conversion is what the arms below measure.
  const predicates = new Map<string, number>()
  const tails = new Map<string, number>()
  const tailSamples = new Map<string, string[]>()
  const noteTail = (key: string, command: string): void => {
    tails.set(key, (tails.get(key) ?? 0) + 1)
    const samples = tailSamples.get(key) ?? []
    if (samples.length < 2) {
      samples.push(oneLine(command))
      tailSamples.set(key, samples)
    }
  }
  for (const row of findShell) {
    const find = asFindShape(row)
    if (!find) {
      noteTail('(not a plain find pipeline)', row.command)
      continue
    }
    const seen = new Set<string>()
    for (const arg of find.argv.slice(1)) {
      if (!arg.startsWith('-') && arg !== '!') continue
      const key = FIND_PREDICATES.has(arg) ? arg : '(other predicate)'
      seen.add(key)
    }
    for (const key of seen) predicates.set(key, (predicates.get(key) ?? 0) + 1)
    if (find.tail.length === 0) {
      noteTail('(no pipe)', row.command)
    } else {
      for (const segment of find.tail) {
        noteTail(`| ${segment.name}`, row.command)
      }
    }
  }

  const printCounts = (
    title: string,
    counts: Map<string, number>,
    samples?: Map<string, string[]>,
  ): void => {
    console.log(`\n  ${title} (over the ${findShell.length} that ran in the shell)`)
    for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(n).padStart(7)}  ${key}`)
      for (const sample of samples?.get(key) ?? []) {
        console.log(`           ${sample}`)
      }
    }
  }
  printCounts('predicates', predicates)
  printCounts('pipe tails', tails, tailSamples)

  // isolated: the arm alone. marginal: leave-one-out against every other arm,
  // which is what it is worth if the rest ship too. They differ by a lot here,
  // because most of these commands carry two unsupported shapes at once.
  //
  // Leave-one-out runs over the BUILDABLE set: an arm's marginal against a set
  // containing G and I would credit those two with rows nobody is going to
  // convert, and understate every arm that overlaps them.
  const hitsWithAll = findShell.filter(row => convertsWith(row, BUILDABLE_ARMS))
  const all = new Set(hitsWithAll)
  const ceiling = new Set(findShell.filter(row => convertsWith(row, FIND_ARMS)))

  console.log(
    `\n  what each find arm converts — isolated, then marginal within the buildable set:\n`,
  )
  for (const arm of FIND_ARMS) {
    const isolated = findShell.filter(row => convertsWith(row, [arm]))
    const others = BUILDABLE_ARMS.filter(other => other.id !== arm.id)
    const withoutIt = new Set(findShell.filter(row => convertsWith(row, others)))
    const onlyThisArm = hitsWithAll.filter(row => !withoutIt.has(row))
    console.log(
      `${String(isolated.length).padStart(7)} isolated  ${String(onlyThisArm.length).padStart(4)} marginal   ${arm.label}`,
    )
    // The commands the arm UNLOCKS are the fixture source for its promotion.
    for (const [command, n] of deduped(
      onlyThisArm.length > 0 ? onlyThisArm : isolated,
    ).slice(0, SAMPLES_PER_ARM)) {
      console.log(`         ${String(n).padStart(3)}×  ${command}`)
    }
  }
  console.log(
    `${String(all.size).padStart(7)}  = union of the BUILDABLE arms, i.e. find conversion ${findConverted.length} → ${
      findConverted.length + all.size
    } of ${findRows.length} (${pct(findConverted.length + all.size, findRows.length)})`,
  )
  console.log(
    `${String(ceiling.size).padStart(7)}  = union including the two upper bounds (G, I) — the ceiling, not a plan`,
  )
}

function reportReasons(scan: Scan): void {
  const byReason = new Map<string, Row[]>()
  for (const row of scan.notRedirected) {
    const reason = reasonFor(row.command)
    const bucket = byReason.get(reason)
    if (bucket) bucket.push(row)
    else byReason.set(reason, [row])
  }
  console.log('\nWhy the shell won, most frequent first:\n')
  for (const [reason, rows] of [...byReason].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`${String(rows.length).padStart(5)}  ${reason}`)
    for (const row of rows.slice(0, SAMPLES_PER_REASON)) {
      console.log(`       ${oneLine(row.command)}`)
    }
  }
}

const enabled = process.env.CLAUDIN_BENCH === '1'

describe.skipIf(!enabled)('Bash→tool redirect gaps', () => {
  test('scan every recorded session', () => {
    for (const { label, root } of CORPORA) {
      const scan = scanCorpus(label, root)
      if (scan.sessions === 0) {
        console.log(`\ncorpus ${label}: no sessions under ${root}, skipped`)
        continue
      }
      const considered = reportHeadline(scan)
      reportShippedArms(scan)
      reportGeneralArms(scan, considered)
      reportFind(scan)
      reportReasons(scan)
    }
  }, 1_200_000)
})
