import { statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import {
  walkCommandSegments,
  type CommandSegment,
} from '../../utils/bash/segments.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { expandTilde } from '../../utils/permissions/pathValidation.js'
import { FILE_READ_TOOL_NAME, MAX_LINES_TO_READ } from '../FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'
import { PATH_EXTRACTORS } from './pathValidation.js'

/**
 * Bash → Read/Grep/Glob redirect.
 *
 * The model reaches for the shell to do what the dedicated tools do — the case
 * that prompted this was `grep -n "" f.ts | sed -n '330,400p' && grep -rn … src`,
 * which is a range Read and a Grep packed into one round-trip. Read's own prompt
 * already advertises offset/limit and the auto-outline pivot deliberately steps
 * aside for range reads (FileReadTool.ts), so nothing was blocking the tool call;
 * the only thing missing was enforcement. BashTool's prompt says "Avoid running
 * find, grep, cat, head, tail, sed, awk, or echo" and that line is advice.
 *
 * An appended <system-reminder> is NOT the lever — that shape was measured in
 * this codebase at zero adoption. What moves behavior is a refusal that names the
 * alternative, so this mirrors RunTestsTool/redirect.ts: validateInput declines
 * once and hands back the exact tool calls to make instead.
 *
 * Where this is DELIBERATELY narrower than the prompt line it enforces:
 *
 *  - `ls` is untouched. Read's own prompt tells the model to list directories
 *    with `ls` via Bash, so refusing it would be self-contradiction.
 *  - `tail` is untouched. `tail -f` is the Monitor tool's job, and `tail -n N`
 *    (the LAST n lines) has no Read spelling without knowing the line count.
 *  - `awk` is untouched. Only `NR>=A && NR<=B` would map, and recognising that
 *    safely means understanding the program.
 *  - `sed -i` is untouched — that is an edit, handled by sedEditParser.ts.
 *
 * All-or-nothing across a compound command: every non-neutral segment must map,
 * or the whole thing runs. `bun run build && cat x.ts` is not a read command, and
 * `cat package.json | jq .scripts` is precisely the case where the shell wins.
 *
 * ONE-SHOT per command: re-sending the identical command runs it. Without that
 * escape the refusal would be a wall rather than a signpost.
 */

export type ToolTarget = 'Read' | 'Grep' | 'Glob'

const TOOL_NAME: Record<ToolTarget, string> = {
  Read: FILE_READ_TOOL_NAME,
  Grep: GREP_TOOL_NAME,
  Glob: GLOB_TOOL_NAME,
}

export type SuggestedCall =
  | {
      tool: 'Read'
      file_path: string
      offset?: number
      limit?: number
      /** limit was reduced to Read's per-call ceiling. */
      clamped?: boolean
    }
  | {
      tool: 'Grep'
      pattern: string
      path?: string
      glob?: string
      output_mode: 'content' | 'count' | 'files_with_matches'
      caseInsensitive?: boolean
      context?: { flag: '-A' | '-B' | '-C'; lines: number }
    }
  | { tool: 'Glob'; pattern: string; path?: string }

/** One pipeline's worth of segments and the calls that replace them. */
export type RedirectUnit = {
  /** The original text, so the message can quote what it declined. */
  text: string
  calls: SuggestedCall[]
}

export type RedirectAnalysis = {
  units: RedirectUnit[]
  /** Every tool the suggestion needs — all must be in the agent's toolset. */
  targets: ToolTarget[]
}

// ---------------------------------------------------------------------------
// Segment → argv
// ---------------------------------------------------------------------------

/**
 * Tokenize one segment into argv, the same way pathValidation's
 * parseCommandArguments does (glob objects flattened to their pattern, empty
 * strings preserved — `grep "" file` depends on that one).
 *
 * Returns null when shell-quote fails OR when any operator token survives.
 * The second case matters: splitCommandWithOperators does not throw on
 * malformed syntax, it hands back the whole command as a single segment, and
 * that segment must not be mistaken for a simple command.
 */
function argvOf(segment: CommandSegment): string[] | null {
  const parsed = tryParseShellCommand(segment.text, name => `$${name}`)
  if (!parsed.success) return null
  const argv: string[] = []
  for (const token of parsed.tokens) {
    if (typeof token === 'string') {
      argv.push(token)
      continue
    }
    if (
      token !== null &&
      typeof token === 'object' &&
      'op' in token &&
      token.op === 'glob' &&
      'pattern' in token
    ) {
      argv.push(String(token.pattern))
      continue
    }
    return null
  }
  if (argv.length === 0) return null
  return argv
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Read needs an absolute path, so resolving is required to build the message at
 * all — and requiring the target to EXIST as a regular file is what keeps the
 * refusal off `cat /dev/null`, `cat` of a file an earlier step would generate,
 * and any typo'd path where the shell's error is the useful answer.
 */
function resolveRegularFile(candidate: string, cwd: string): string | null {
  const abs = toAbsolute(candidate, cwd)
  try {
    return statSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}

/** Grep/Glob take a directory OR a file, so existence is all that is required. */
function resolveExistingPath(candidate: string, cwd: string): string | null {
  const abs = toAbsolute(candidate, cwd)
  try {
    statSync(abs)
    return abs
  } catch {
    return null
  }
}

function toAbsolute(candidate: string, cwd: string): string {
  const clean = expandTilde(candidate.replace(/^['"]|['"]$/g, ''))
  return isAbsolute(clean) ? clean : resolve(cwd, clean)
}

// ---------------------------------------------------------------------------
// Line windows
// ---------------------------------------------------------------------------

/** 1-indexed offset with an optional length, matching Read's own parameters. */
type LineWindow = { offset: number; limit?: number }

const IDENTITY_WINDOW: LineWindow = { offset: 1 }

/**
 * Compose a selector onto the window already selected upstream, e.g.
 * `cat f | head -n 100 | sed -n '10,20p'`. The selector's coordinates are
 * relative to what its input produced, so its offset shifts by the window's
 * origin and its length cannot exceed what remains.
 */
function composeWindow(base: LineWindow, next: LineWindow): LineWindow {
  const offset = base.offset + next.offset - 1
  if (next.limit === undefined) {
    if (base.limit === undefined) return { offset }
    return { offset, limit: Math.max(base.limit - (next.offset - 1), 0) }
  }
  if (base.limit === undefined) return { offset, limit: next.limit }
  return {
    offset,
    limit: Math.max(Math.min(next.limit, base.limit - (next.offset - 1)), 0),
  }
}

// ---------------------------------------------------------------------------
// Per-command parsing
// ---------------------------------------------------------------------------

/**
 * What a segment turned out to be. A `selector` reads stdin and only narrows
 * lines, so it can be folded into whatever the pipeline's head produced; a
 * `source` produces the calls itself.
 */
type SegmentRole =
  | { kind: 'source'; calls: SuggestedCall[]; window?: LineWindow }
  | { kind: 'selector'; window: LineWindow }

/** `sed -n '330,400p'`, `sed -n 5p`, `sed -n '330,$p'` — nothing else. */
const SED_RANGE_RE = /^(\d+)(?:,(\d+|\$))?p$/

function parseSed(argv: string[], cwd: string): SegmentRole | null {
  const args = argv.slice(1)
  let quiet = false
  let script: string | undefined
  const positional: string[] = []
  for (const arg of args) {
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
      quiet = true
      continue
    }
    // -n is the only flag with a Read spelling. Everything else either edits
    // (-i), adds scripts (-e, -f), changes the regex dialect (-E, -r) or the
    // record separator (-z, -s) — none of which a range read reproduces.
    if (arg.startsWith('-') && arg !== '-') return null
    if (script === undefined) {
      script = arg
      continue
    }
    positional.push(arg)
  }
  // Without -n, sed prints every line AND the selected range twice; that is not
  // a range read.
  if (!quiet || script === undefined) return null
  const match = SED_RANGE_RE.exec(script)
  if (!match) return null
  const start = Number(match[1])
  if (!Number.isFinite(start) || start < 1) return null
  const end = match[2]
  const window: LineWindow =
    end === undefined
      ? { offset: start, limit: 1 }
      : end === '$'
        ? { offset: start }
        : { offset: start, limit: Number(end) - start + 1 }
  if (window.limit !== undefined && window.limit < 1) return null

  if (positional.length === 0) return { kind: 'selector', window }
  if (positional.length > 1) return null
  const file = resolveRegularFile(positional[0]!, cwd)
  if (!file) return null
  return { kind: 'source', calls: [{ tool: 'Read', file_path: file }], window }
}

/** `cat f`, `cat -n f`, `cat a b c`, and the no-path forms used as selectors. */
const CAT_ALLOWED_FLAGS = new Set(['-n', '--number'])

function parseCat(argv: string[], cwd: string): SegmentRole | null {
  const args = argv.slice(1)
  let afterDoubleDash = false
  for (const arg of args) {
    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (afterDoubleDash || !arg.startsWith('-') || arg === '-') continue
    if (!CAT_ALLOWED_FLAGS.has(arg)) return null
  }
  const paths = PATH_EXTRACTORS.cat(args)
  // Line numbering is what Read does anyway, so a bare `cat -n` in a pipe is a
  // no-op selector rather than a reason to stand down.
  if (paths.length === 0) return { kind: 'selector', window: IDENTITY_WINDOW }
  const calls: SuggestedCall[] = []
  for (const candidate of paths) {
    const file = resolveRegularFile(candidate, cwd)
    if (!file) return null
    calls.push({ tool: 'Read', file_path: file })
  }
  return { kind: 'source', calls }
}

function parseNl(argv: string[], cwd: string): SegmentRole | null {
  const args = argv.slice(1)
  // nl's formatting flags (-b, -w, -s, -v) all change the output shape, and
  // Read has exactly one line-number format.
  if (args.some(arg => arg.startsWith('-') && arg !== '-')) return null
  if (args.length === 0) return { kind: 'selector', window: IDENTITY_WINDOW }
  if (args.length > 1) return null
  const file = resolveRegularFile(args[0]!, cwd)
  if (!file) return null
  return { kind: 'source', calls: [{ tool: 'Read', file_path: file }] }
}

const HEAD_DEFAULT_LINES = 10

function parseHead(argv: string[], cwd: string): SegmentRole | null {
  const args = argv.slice(1)
  let lines = HEAD_DEFAULT_LINES
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    if (arg === '-n' || arg === '--lines') {
      const value = args[++i]
      if (value === undefined) return null
      const parsed = parseLineCount(value)
      if (parsed === null) return null
      lines = parsed
      continue
    }
    if (arg.startsWith('--lines=')) {
      const parsed = parseLineCount(arg.slice('--lines='.length))
      if (parsed === null) return null
      lines = parsed
      continue
    }
    // `head -20` and `head -n20`.
    const fused = arg.startsWith('-n') ? arg.slice(2) : arg.slice(1)
    const parsed = parseLineCount(fused)
    if (parsed === null) return null
    lines = parsed
  }
  const window: LineWindow = { offset: 1, limit: lines }
  if (positional.length === 0) return { kind: 'selector', window }
  // With two or more files head interleaves `==> name <==` banners; that is a
  // different output, not several Reads.
  if (positional.length > 1) return null
  const file = resolveRegularFile(positional[0]!, cwd)
  if (!file) return null
  return { kind: 'source', calls: [{ tool: 'Read', file_path: file }], window }
}

/** Rejects `-c`/byte counts, negatives (`head -n -5`) and junk. */
function parseLineCount(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 ? n : null
}

// --- grep / rg -------------------------------------------------------------

type PatternFlags = {
  recursive: boolean
  caseInsensitive: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  includes: string[]
  context?: { flag: '-A' | '-B' | '-C'; lines: number }
}

/** Short options that take no value, so they can be written clustered. */
const GREP_SHORT_NO_ARG = new Set(['r', 'R', 'i', 'n', 'c', 'l', 'E'])

/** Short options that take a value, fused (`-C3`) or separate (`-C 3`). */
const GREP_SHORT_WITH_ARG = new Set(['A', 'B', 'C'])

/**
 * `grep -rn foo src` is the form people actually type, and a switch over whole
 * argv tokens never sees `-r` or `-n` in it. Expand clusters into their
 * constituent flags before parsing; anything that does not decompose cleanly is
 * left intact, so the parser's default arm still stands the redirect down.
 */
function expandShortFlagClusters(args: string[]): string[] {
  const out: string[] = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      out.push(arg)
      continue
    }
    if (
      afterDoubleDash ||
      !arg.startsWith('-') ||
      arg.startsWith('--') ||
      arg === '-'
    ) {
      out.push(arg)
      continue
    }
    const body = arg.slice(1)
    // `-C3`, and the clustered `-rnC3` form.
    const fused = /^([A-Za-z]*)([ABC])(\d+)$/.exec(body)
    if (fused && [...fused[1]!].every(ch => GREP_SHORT_NO_ARG.has(ch))) {
      for (const ch of fused[1]!) out.push(`-${ch}`)
      out.push(`-${fused[2]}`, fused[3]!)
      continue
    }
    if (body.length > 1) {
      const head = body.slice(0, -1)
      const last = body.slice(-1)
      const headOk = [...head].every(ch => GREP_SHORT_NO_ARG.has(ch))
      if (
        headOk &&
        (GREP_SHORT_NO_ARG.has(last) || GREP_SHORT_WITH_ARG.has(last))
      ) {
        for (const ch of body) out.push(`-${ch}`)
        continue
      }
    }
    out.push(arg)
  }
  return out
}

function parseGrep(
  argv: string[],
  cwd: string,
  tool: 'grep' | 'rg',
): SegmentRole | null {
  const args = expandShortFlagClusters(argv.slice(1))
  const flags: PatternFlags = {
    recursive: tool === 'rg',
    caseInsensitive: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    includes: [],
  }
  const positional: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }
    if (afterDoubleDash || !arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    const [name, fusedValue] = splitFlagValue(arg)
    const readValue = (): string | null => {
      if (fusedValue !== undefined) return fusedValue
      const next = args[++i]
      return next === undefined ? null : next
    }
    switch (name) {
      case '-r':
      case '-R':
      case '--recursive':
        flags.recursive = true
        break
      case '-i':
      case '--ignore-case':
        flags.caseInsensitive = true
        break
      case '-n':
      case '--line-number':
        flags.lineNumbers = true
        break
      case '-c':
      case '--count':
        flags.countOnly = true
        break
      case '-l':
      case '--files-with-matches':
        flags.filesOnly = true
        break
      case '-E':
      case '--extended-regexp':
        // rg is extended by default and Grep sends the pattern to rg, so this
        // is the identity for grep and a no-op for rg.
        if (tool === 'rg') return null
        break
      case '--include':
      case '-g':
      case '--glob': {
        const value = readValue()
        if (value === null) return null
        flags.includes.push(value)
        break
      }
      case '-A':
      case '-B':
      case '-C': {
        const value = readValue()
        if (value === null) return null
        const lines = parseLineCount(value)
        if (lines === null) return null
        // Grep takes one context window, not a combination.
        if (flags.context) return null
        flags.context = { flag: name, lines }
        break
      }
      default:
        // -v, -o, -P, -z, -m, -w, -F, --color … all mean something Grep cannot
        // reproduce. Standing down is the safe answer for every one of them.
        return null
    }
  }

  if (flags.countOnly && flags.filesOnly) return null
  if (positional.length === 0) return null
  const pattern = positional[0]!
  const paths = positional.slice(1)
  if (paths.length > 1) return null

  // `grep -n "" file` matches every line — a whole-file read wearing a search's
  // clothes. It is the exact idiom that produced this feature.
  if (
    pattern === '' &&
    !flags.recursive &&
    !flags.countOnly &&
    !flags.filesOnly &&
    paths.length === 1
  ) {
    const file = resolveRegularFile(paths[0]!, cwd)
    if (!file) return null
    return { kind: 'source', calls: [{ tool: 'Read', file_path: file }] }
  }
  if (pattern === '') return null

  let path: string | undefined
  if (paths.length === 1) {
    // Resolved only to prove it exists — Grep is happy with the relative form
    // the model already wrote, and echoing that keeps the suggestion readable.
    if (!resolveExistingPath(paths[0]!, cwd)) return null
    path = paths[0]!
  } else if (!flags.recursive) {
    // Non-recursive grep with no path reads stdin — that is a filter on someone
    // else's output, not a search of the tree.
    return null
  }

  const glob = combineIncludes(flags.includes)
  if (glob === null) return null

  return {
    kind: 'source',
    calls: [
      {
        tool: 'Grep',
        pattern,
        path,
        glob,
        output_mode: flags.countOnly
          ? 'count'
          : flags.filesOnly
            ? 'files_with_matches'
            : 'content',
        caseInsensitive: flags.caseInsensitive || undefined,
        context: flags.context,
      },
    ],
  }
}

/** `--flag=value` → ['--flag', 'value']; `--flag` → ['--flag', undefined]. */
function splitFlagValue(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  if (eq === -1) return [arg, undefined]
  return [arg.slice(0, eq), arg.slice(eq + 1)]
}

/**
 * Grep takes ONE glob. Several `--include`s collapse only in the shape people
 * actually write them (`--include=*.ts --include=*.tsx` → `*.{ts,tsx}`);
 * anything else stands down rather than silently searching a different set.
 */
function combineIncludes(includes: string[]): string | undefined | null {
  if (includes.length === 0) return undefined
  if (includes.length === 1) return includes[0]
  const extensions: string[] = []
  for (const include of includes) {
    const match = /^\*\.(\w+)$/.exec(include)
    if (!match) return null
    extensions.push(match[1]!)
  }
  return `*.{${extensions.join(',')}}`
}

// --- find ------------------------------------------------------------------

function parseFind(argv: string[], cwd: string): SegmentRole | null {
  const args = argv.slice(1)
  const roots: string[] = []
  let namePattern: string | undefined
  let pathPattern: string | undefined
  let sawTypeFile = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-')) {
      // Positional roots only come before the predicates.
      if (namePattern !== undefined || pathPattern !== undefined) return null
      roots.push(arg)
      continue
    }
    switch (arg) {
      case '-name': {
        const value = args[++i]
        if (value === undefined || namePattern !== undefined) return null
        namePattern = value
        break
      }
      case '-path': {
        const value = args[++i]
        if (value === undefined || pathPattern !== undefined) return null
        pathPattern = value
        break
      }
      case '-type': {
        const value = args[++i]
        // Glob returns files. `-type d` and `-type l` have no spelling.
        if (value !== 'f') return null
        sawTypeFile = true
        break
      }
      default:
        // -exec, -delete, -maxdepth, -mtime, -size, -newer, -iname, -o, -not …
        return null
    }
  }
  if (roots.length > 1) return null
  if (namePattern === undefined && pathPattern === undefined && !sawTypeFile) {
    return null
  }

  const root = roots[0]
  if (root !== undefined && !resolveExistingPath(root, cwd)) return null

  // -path is already a path pattern; -name matches the basename at any depth.
  const pattern =
    pathPattern !== undefined
      ? pathPattern.replace(/^\.\//, '')
      : namePattern !== undefined
        ? `**/${namePattern}`
        : '**/*'

  return {
    kind: 'source',
    calls: [
      {
        tool: 'Glob',
        pattern,
        path: root === undefined || root === '.' ? undefined : root,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Segment dispatch
// ---------------------------------------------------------------------------

function classifySegment(
  segment: CommandSegment,
  cwd: string,
): SegmentRole | null {
  const argv = argvOf(segment)
  if (!argv) return null
  switch (segment.name) {
    case 'cat':
      return parseCat(argv, cwd)
    case 'nl':
      return parseNl(argv, cwd)
    case 'head':
      return parseHead(argv, cwd)
    case 'sed':
      return parseSed(argv, cwd)
    case 'grep':
    case 'egrep':
      return parseGrep(argv, cwd, 'grep')
    case 'rg':
      return parseGrep(argv, cwd, 'rg')
    case 'find':
      return parseFind(argv, cwd)
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Whole-command analysis
// ---------------------------------------------------------------------------

/**
 * Returns the calls that replace `command`, or null when the command should run
 * as written. Pure — the one-shot bookkeeping lives in shouldRedirectToTools.
 */
export function analyzeCommandForRedirect(
  command: string,
  cwd: string,
): RedirectAnalysis | null {
  const walked = walkCommandSegments(command)
  if (!walked) return null
  // Writing to a file is not reading into context, and no tool does it.
  if (walked.hasOutputRedirection) return null

  const units: RedirectUnit[] = []
  for (const group of groupPipelines(walked.segments)) {
    // A group of nothing but `echo`s carries no intent to redirect.
    if (group.every(segment => segment.isNeutral)) continue
    const unit = classifyPipeline(group, cwd)
    if (!unit) return null
    units.push(unit)
  }
  if (units.length === 0) return null

  const targets = [...new Set(units.flatMap(u => u.calls.map(c => c.tool)))]
  return { units, targets }
}

/** Consecutive segments joined by `|`; every other operator starts a group. */
function groupPipelines(segments: CommandSegment[]): CommandSegment[][] {
  const groups: CommandSegment[][] = []
  for (const segment of segments) {
    if (segment.joinedBy === '|' && groups.length > 0) {
      groups[groups.length - 1]!.push(segment)
    } else {
      groups.push([segment])
    }
  }
  return groups
}

function classifyPipeline(
  group: CommandSegment[],
  cwd: string,
): RedirectUnit | null {
  // There is deliberately NO neutral-segment guard here. `cat f | echo hi`
  // discards the read and must stand down, but classifySegment has no arm for
  // `echo`, so it already returns null in both the head and the tail position —
  // and a group that is ENTIRELY neutral never reaches this function. A guard
  // would be dead code that reads like a safety net: the break-and-restore
  // audit removed it and the suite stayed green, which is how it was caught.
  const head = classifySegment(group[0]!, cwd)
  if (!head || head.kind !== 'source') return null

  // Only a single Read has a line window to narrow. Folding a selector into a
  // Grep, a Glob or several Reads would change what the model gets back.
  const only = head.calls.length === 1 ? head.calls[0] : undefined
  const readCall = only?.tool === 'Read' ? only : undefined

  let window: LineWindow = head.window ?? IDENTITY_WINDOW
  for (const segment of group.slice(1)) {
    if (!readCall) return null
    const role = classifySegment(segment, cwd)
    if (!role || role.kind !== 'selector') return null
    window = composeWindow(window, role.window)
    if (window.limit !== undefined && window.limit < 1) return null
  }

  const calls = readCall ? [applyWindow(readCall, window)] : head.calls
  return { text: group.map(segment => segment.text).join(' | '), calls }
}

function applyWindow(
  call: Extract<SuggestedCall, { tool: 'Read' }>,
  window: LineWindow,
): SuggestedCall {
  const next: Extract<SuggestedCall, { tool: 'Read' }> = {
    tool: 'Read',
    file_path: call.file_path,
  }
  if (window.offset > 1) next.offset = window.offset
  if (window.limit !== undefined) {
    if (window.limit > MAX_LINES_TO_READ) {
      next.limit = MAX_LINES_TO_READ
      next.clamped = true
    } else {
      next.limit = window.limit
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// One-shot memo
// ---------------------------------------------------------------------------

/**
 * Commands already refused once. Cleared wholesale past the limit — re-arming
 * after this many distinct commands in one session is a better failure than a
 * set that grows for the life of the process. Same shape and same reasoning as
 * the RunTests redirect's memo.
 */
const refusedCommands = new Set<string>()
const MEMO_LIMIT = 100

/**
 * Records the command as refused, so the SECOND identical call runs — the
 * escape hatch the message promises. Returns the analysis to render, or null.
 *
 * `hasTool` is checked BEFORE the one-shot is consumed, and deliberately so:
 * refusing Bash without an alternative would be a dead end, and burning the
 * escape on a refusal that never happened would make the NEXT attempt — the one
 * where the tool might be present — run unchallenged. Every target must be
 * available; a suggestion that names a tool the agent cannot call is worse than
 * silence. Ant-native builds fall out of this for free: `hasEmbeddedSearchTools`
 * removes Glob/Grep from the registry there.
 *
 * Safe to consume the one-shot here because `validateInput` has exactly one
 * call site (`services/tools/toolExecution.ts`) and runs once per tool call.
 */
export function shouldRedirectToTools(
  command: string,
  cwd: string,
  hasTool: (toolName: string) => boolean,
): RedirectAnalysis | null {
  const analysis = analyzeCommandForRedirect(command, cwd)
  if (!analysis) return null
  if (!analysis.targets.every(target => hasTool(TOOL_NAME[target]))) return null
  const key = command.trim()
  if (refusedCommands.has(key)) return null
  if (refusedCommands.size >= MEMO_LIMIT) refusedCommands.clear()
  refusedCommands.add(key)
  return analysis
}

export function resetToolRedirectMemoForTesting(): void {
  refusedCommands.clear()
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export function renderToolRedirect(
  command: string,
  analysis: RedirectAnalysis,
): string {
  const names = analysis.targets.map(target => TOOL_NAME[target]).join('/')
  const lines: string[] = [
    `Blocked: this command reads and searches files, and ${names} ${
      analysis.targets.length > 1 ? 'are' : 'is'
    } available.`,
    '',
  ]
  const multiUnit = analysis.units.length > 1
  analysis.units.forEach((unit, index) => {
    lines.push(
      multiUnit
        ? `Segment ${index + 1} — \`${unit.text}\``
        : `\`${unit.text}\``,
    )
    for (const call of unit.calls) {
      lines.push(`  → ${renderCall(call)}`)
    }
    lines.push('')
  })
  const totalCalls = analysis.units.reduce((n, u) => n + u.calls.length, 0)
  if (totalCalls > 1) {
    lines.push('Emit them as parallel tool_use blocks in one message.')
  }
  lines.push(
    'If you genuinely need the shell form, re-send this exact Bash command and it will run.',
  )
  return lines.join('\n')
}

function renderCall(call: SuggestedCall): string {
  switch (call.tool) {
    case 'Read': {
      const args = [`file_path: ${JSON.stringify(call.file_path)}`]
      if (call.offset !== undefined) args.push(`offset: ${call.offset}`)
      if (call.limit !== undefined) args.push(`limit: ${call.limit}`)
      const clamped = call.clamped
        ? `  (limit clamped to ${FILE_READ_TOOL_NAME}'s ${MAX_LINES_TO_READ}-line ceiling)`
        : ''
      return `${FILE_READ_TOOL_NAME}(${args.join(', ')})${clamped}`
    }
    case 'Grep': {
      const args = [`pattern: ${JSON.stringify(call.pattern)}`]
      if (call.path !== undefined) args.push(`path: ${JSON.stringify(call.path)}`)
      if (call.glob !== undefined) args.push(`glob: ${JSON.stringify(call.glob)}`)
      args.push(`output_mode: ${JSON.stringify(call.output_mode)}`)
      if (call.caseInsensitive) args.push('"-i": true')
      if (call.context) args.push(`"${call.context.flag}": ${call.context.lines}`)
      return `${GREP_TOOL_NAME}(${args.join(', ')})`
    }
    case 'Glob': {
      const args = [`pattern: ${JSON.stringify(call.pattern)}`]
      if (call.path !== undefined) args.push(`path: ${JSON.stringify(call.path)}`)
      return `${GLOB_TOOL_NAME}(${args.join(', ')})`
    }
  }
}
