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

import { walkCommandSegments } from '../../../src/platform/bash/segments.js'
import { tryParseShellCommand } from '../../../src/platform/bash/shellQuote.js'
import { breToEre } from '../../../src/tools/BashTool/breToEre.js'
import {
  analyzeCommandForRedirect,
  type RedirectUnit,
} from '../../../src/tools/BashTool/toolRedirect.js'

const ROOT = `${process.env.HOME}/.claudin/projects`
const SAMPLES_PER_REASON = 4

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

function argvOfSingleSegment(
  command: string,
  heads: ReadonlySet<string>,
): string[] | null {
  const walked = walkCommandSegments(command)
  if (!walked || walked.hasOutputRedirection) return null
  if (walked.segments.length !== 1) return null
  const segment = walked.segments[0]!
  if (!heads.has(segment.name)) return null
  const parsed = tryParseShellCommand(segment.text, name => `$${name}`)
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

type Row = { command: string; cwd: string; units?: RedirectUnit[] }

function sessionFiles(): string[] {
  if (!existsSync(ROOT)) return []
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
  walk(ROOT)
  return out
}

const enabled = process.env.CLAUDIN_BENCH === '1'

describe.skipIf(!enabled)('Bash→tool redirect gaps', () => {
  test('scan every recorded session', () => {
    const redirected: Row[] = []
    const notRedirected: Row[] = []
    let staleCwd = 0
    let sessions = 0
    let bashCalls = 0

    for (const file of sessionFiles()) {
      sessions++
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
          bashCalls++
          if (!READ_SEARCH_HEAD_RE.test(command)) continue
          if (!cwd || !existsSync(cwd)) {
            staleCwd++
            continue
          }
          let analysis = null
          try {
            analysis = analyzeCommandForRedirect(command, cwd)
          } catch {
            // The analyzer stats paths; an unreadable one is not a finding.
          }
          if (analysis) redirected.push({ command, cwd, units: analysis.units })
          else notRedirected.push({ command, cwd })
        }
      }
    }

    const considered = redirected.length + notRedirected.length
    const pct = (n: number, of: number): string =>
      of === 0 ? '—' : `${((n / of) * 100).toFixed(1)}%`

    console.log(`sessions scanned      ${sessions}`)
    console.log(`Bash calls            ${bashCalls}`)
    console.log(
      `read/search calls     ${considered}  (${pct(considered, bashCalls)} of Bash)`,
    )
    console.log(`  skipped, stale cwd  ${staleCwd}`)
    console.log(
      `  redirected          ${redirected.length}  (${pct(redirected.length, considered)})`,
    )
    console.log(
      `  ran in the shell    ${notRedirected.length}  (${pct(notRedirected.length, considered)})`,
    )

    // Which of the redirects only exist because of the arms added in this
    // round — the honest way to size them without replaying an old build.
    // COMMANDS, not calls. One command can now produce several Grep calls, and
    // counting those would inflate an arm's credit by however many paths the
    // command happened to name.
    let viaTranslation = 0
    let viaIname = 0
    let viaFilter = 0
    let viaSeveralPaths = 0
    for (const row of redirected) {
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
    console.log(`\nRedirects owed to the new arms:`)
    console.log(`  BRE pattern translated   ${viaTranslation}`)
    console.log(`  find -iname → Glob -i    ${viaIname}`)
    console.log(`  source | grep folded     ${viaFilter}`)
    console.log(`  several paths → N calls  ${viaSeveralPaths}`)

    const byReason = new Map<string, Row[]>()
    for (const row of notRedirected) {
      const reason = reasonFor(row.command)
      const bucket = byReason.get(reason)
      if (bucket) bucket.push(row)
      else byReason.set(reason, [row])
    }

    console.log(
      '\nWhat each candidate arm would convert (real analyzer, rewritten shape):\n',
    )
    const converted = new Set<Row>()
    for (const { label, converts } of ARMS) {
      const hits: Row[] = []
      for (const row of notRedirected) {
        try {
          if (converts(row)) hits.push(row)
        } catch {
          // A sizing probe is best-effort; one throwing must not drop the run.
        }
      }
      for (const row of hits) converted.add(row)
      console.log(`${String(hits.length).padStart(5)}  ${label}`)
      for (const row of hits.slice(0, SAMPLES_PER_REASON)) {
        const oneLine = row.command.replace(/\s+/g, ' ').trim()
        console.log(
          `       ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine}`,
        )
      }
    }
    // The arms overlap, so this is the number that matters, not their sum.
    console.log(
      `${String(converted.size).padStart(5)}  = union, i.e. reach ${redirected.length} → ${
        redirected.length + converted.size
      } (${pct(redirected.length + converted.size, considered)} of read/search calls)`,
    )

    console.log('\nWhy the shell won, most frequent first:\n')
    for (const [reason, rows] of [...byReason].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      console.log(`${String(rows.length).padStart(5)}  ${reason}`)
      for (const row of rows.slice(0, SAMPLES_PER_REASON)) {
        const oneLine = row.command.replace(/\s+/g, ' ').trim()
        console.log(
          `       ${oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine}`,
        )
      }
    }
  }, 600_000)
})
