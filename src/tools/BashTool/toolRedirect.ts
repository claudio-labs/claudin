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
import { createOneShotMemo, MEMO_LIMIT } from '../shared/redirect.js'
import { PATH_EXTRACTORS } from './pathValidation.js'

export { MEMO_LIMIT }

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
 *
 * On by default; `CLAUDIN_DISABLE_TOOL_REDIRECT=1` turns the whole lane off (see
 * BashTool.tsx). Deliberately NOT documented in AGENTS.md: that file is read by
 * every agent harness that opens this repo, and a Claudin-only refusal listed
 * there reads as an instruction the others cannot honor.
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
      /**
       * Opts out of FileReadTool's auto-outline pivot. Only set when there is
       * no window at all — see withFullBody.
       */
      view?: 'full'
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
      /**
       * The window a trailing selector folded in — `| head -N` becomes
       * `head_limit`, `| sed -n 'A,Bp'` adds `offset`. Grep's `offset` skips
       * N entries and is 0-INDEXED, unlike the 1-indexed `LineWindow` this
       * module carries (and unlike Read's own `offset`), so applyWindow
       * converts rather than copying.
       */
      offset?: number
      head_limit?: number
     /**
      * The search walks a directory tree, where ripgrep honors .gitignore
      * and the `grep -r` it replaces did not — the refusal message names
      * that divergence. Only set on a tree walk; a file search answers
      * identically. (Glob needs no such flag: it defaults to --no-ignore.)
      */
     walksTree?: boolean
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
 * Command substitution survives shell-quote's parse as ordinary text — `$(id -u)`
 * comes back as the four characters, and `` `foo` `` as a token still wearing its
 * backticks. A NAMED variable is caught by the resolver instead (see argvOf); the
 * resolver cannot decide this one, because shell-quote calls it with an empty name
 * for a bare trailing `$` (the BRE anchor in `grep "foo$"`) and for `$(` alike.
 */
const SHELL_SUBSTITUTION_RE = /\$\(|`/

/**
 * Tokenize one segment into argv, the same way pathValidation's
 * parseCommandArguments does (glob objects flattened to their pattern, empty
 * strings preserved — `grep "" file` depends on that one).
 *
 * Returns null when shell-quote fails OR when any operator token survives.
 * The second case matters: splitCommandWithOperators does not throw on
 * malformed syntax, it hands back the whole command as a single segment, and
 * that segment must not be mistaken for a simple command.
 *
 * Also returns null the moment the segment expands anything. The resolver hands
 * the SOURCE text back (`$PAT` → `$PAT`), so downstream nothing can tell an
 * expansion from a literal. Every PATH argument is existence-checked and would
 * fail on its own, but a grep pattern and a find -name are not validated at all:
 * `grep -rE "$PAT" src` would otherwise suggest a search for the four characters
 * `$PAT`, answer nothing, and never say why.
 */
function argvOf(segment: CommandSegment): string[] | null {
  let expandsAVariable = false
  const parsed = tryParseShellCommand(segment.text, name => {
    if (name !== '') expandsAVariable = true
    return `$${name}`
  })
  if (!parsed.success) return null
  if (expandsAVariable) return null
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
  if (argv.some(arg => SHELL_SUBSTITUTION_RE.test(arg))) return null
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

/**
 * `find`'s root is walked, so pointing it at a file yields nothing a Glob root
 * can express — `find AGENTS.md -type f` prints the file, while
 * `Glob(pattern: "**\/*", path: "AGENTS.md")` is not even a legal search.
 */
function resolveDirectory(candidate: string, cwd: string): string | null {
  const abs = toAbsolute(candidate, cwd)
  try {
    return statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

function toAbsolute(candidate: string, cwd: string): string {
  const clean = expandTilde(candidate.replace(/^['"]|['"]$/g, ''))
  return isAbsolute(clean) ? clean : resolve(cwd, clean)
}

/**
 * GrepTool excludes VCS metadata unconditionally (`--glob '!.git'`, …), so a
 * search aimed INTO one answers nothing at all — `grep -rn foo .git` has real
 * hits and the suggested Grep is confidently empty. Kept in sync by hand with
 * VCS_DIRECTORIES_TO_EXCLUDE in GrepTool.ts; importing that module would drag
 * the whole tool in for six strings.
 */
const VCS_DIRECTORIES_GREP_EXCLUDES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
])

function targetsExcludedVcsDir(candidate: string): boolean {
  return candidate.split('/').some(part => VCS_DIRECTORIES_GREP_EXCLUDES.has(part))
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
    // -n is the only flag with a Read spelling, and every other one is already
    // barred without a check of its own: it lands in `script` (or shifts the
    // real script into `positional`), and SED_RANGE_RE only matches `N[,N|$]p`,
    // which no flag can spell. An explicit reject here read like a safety net,
    // but a break-and-restore pass showed nothing observed it.
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
  noFilename: boolean
  includes: string[]
  context?: { flag: '-A' | '-B' | '-C'; lines: number }
}

/** Short options that take no value, so they can be written clustered. */
const GREP_SHORT_NO_ARG = new Set(['r', 'R', 'i', 'n', 'c', 'l', 'E', 'h'])

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

/**
 * Metacharacters whose meaning DIVERGES between grep's default BRE and the
 * dialect ripgrep speaks. `grep 'foo\|bar'` is an alternation while rg reads
 * the same string as a literal pipe — and `grep 'foo|bar'` is the exact
 * inverse. Grep hands the pattern to rg verbatim, so a BRE pattern carrying any
 * of these would quietly answer with a different result set than the command it
 * replaced, which is worse than not redirecting at all.
 *
 * Deliberately blunt: `grep 'a\.b'` loses the redirect even though `\.` means
 * the same in both. Translating BRE to ERE is the alternative and it is its own
 * bug surface (character classes, `\{n,m\}`, POSIX classes, nested escapes);
 * standing down costs a round-trip, translating wrong costs correctness.
 */
const BRE_DIVERGENT_RE = /[\\|(){}+?]/

/** A character that opens a POSIX class/collating/equivalence inside [...]. */
const POSIX_CLASS_OPEN_RE = /^[:=.]$/

/**
 * Maps each pattern position to whether it sits inside a POSIX bracket
 * expression — the engines disagree about escapes there differently than
 * outside, so both dialect gates key off the scan. Tracks the POSIX corner
 * cases: a leading `^` negates, a `]` in first position is a literal, and
 * `[:alpha:]`-style classes nest their own `[:…:]` pair — closing at that
 * inner `]` desyncs the scan and would flag a `^` that is still inside the
 * bracket (an over-gate, but a needless one). An unclosed `[` aborts both
 * engines alike, so the rest of the pattern is treated as outside.
 */
function bracketSpans(pattern: string): boolean[] {
  const inBracket: boolean[] = new Array<boolean>(pattern.length).fill(false)
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] !== '[') {
      i++
      continue
    }
    let j = i + 1
    if (pattern[j] === '^') j++
    if (pattern[j] === ']') j++
    let closed = false
    while (j < pattern.length) {
      if (pattern[j] === '[' && POSIX_CLASS_OPEN_RE.test(pattern[j + 1] ?? '')) {
        const closer = pattern.indexOf(pattern[j + 1]! + ']', j + 2)
        if (closer !== -1) {
          j = closer + 2
          continue
        }
      }
      if (pattern[j] === ']') {
        closed = true
        break
      }
      j++
    }
    if (!closed) break
    for (let k = i; k <= j; k++) inBracket[k] = true
    i = j + 1
  }
  return inBracket
}

/**
 * Anchors and the repetition star diverge by POSITION, so the character
 * class above cannot see them. In POSIX BRE `^` and `$` are special only at
 * the pattern's edges — `grep 'a^b'` matches a literal caret — while
 * ripgrep reads an anchor anywhere and answers with ZERO matches: a silent
 * divergence. A leading `*` repeats nothing to rg, which aborts with a
 * parse error, and is a literal star to grep. Inside a bracket expression
 * all three are literal in both dialects, so the scan tracks brackets —
 * otherwise `grep '[^f]oo'` would stand down for nothing.
 */
function hasDivergentBreAnchors(pattern: string): boolean {
  const inBracket = bracketSpans(pattern)
  for (let i = 0; i < pattern.length; i++) {
    if (inBracket[i]) continue
    const ch = pattern[i]!
    if (ch === '^' && i !== 0) return true
    if (ch === '$' && i !== pattern.length - 1) return true
    if (ch === '*' && (i === 0 || (i === 1 && pattern[0] === '^'))) return true
  }
  return false
}

const ALNUM_RE = /[A-Za-z0-9]/
const ERE_SHARED_ESCAPE_RE = /[wWsSbB]/

/**
 * In ERE the divergent escapes are POSITIONAL. Outside a bracket expression
 * only the ALPHANUMERIC escapes the two engines do not share stand down —
 * `grep -E 'foo\d'` matches "food" (the \d is a literal d, with only a
 * "stray \" warning on stderr) while rg matches "foo9": the same count on
 * DIFFERENT lines, a divergence nothing downstream can detect.
 * Back-references (\1…\9) fall out of the same rule, and \w \W \s \S \b \B
 * pass — GNU honors them outside brackets by extension, verified equal to
 * rg. INSIDE brackets POSIX makes the backslash ordinary, so grep reads
 * [\w] as the literals '\' and 'w' where rg reads a word class ([\b] even
 * aborts rg): any backslash there diverges. Finally, a repetition operator
 * with no preceding atom — at the start or right after `(` or `|` — is a
 * literal to grep (with a warning) and a parse error to rg; after `^` the
 * two AGREE (rg accepts anchor repetition), so that position does not gate.
 */
function hasDivergentEreSyntax(pattern: string): boolean {
  const inBracket = bracketSpans(pattern)
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') {
      if (inBracket[i]) return true
      const next = pattern[i + 1]
      if (
        next !== undefined &&
        ALNUM_RE.test(next) &&
        !ERE_SHARED_ESCAPE_RE.test(next)
      ) {
        return true
      }
      i++ // the escaped char is consumed by the escape — never gated itself
      continue
    }
    if (inBracket[i]) continue
    const noAtomBefore = i === 0 || pattern[i - 1] === '(' || pattern[i - 1] === '|'
    if (noAtomBefore && (ch === '*' || ch === '+' || ch === '?')) return true
    // A leading interval — `{2}a` is literal to grep, a parse error to rg.
    // (A brace that is not a valid interval is a literal to both; gating it
    // too only ever over-stands-down.)
    if (noAtomBefore && ch === '{') return true
  }
  return false
}

function parseGrep(
  argv: string[],
  cwd: string,
  tool: 'grep' | 'egrep' | 'rg',
): SegmentRole | null {
  const args = expandShortFlagClusters(argv.slice(1))
  // egrep is ERE by definition and rg's engine is ERE-ish; only bare grep is
  // BRE, and -E flips it.
  let dialect: 'bre' | 'ere' = tool === 'grep' ? 'bre' : 'ere'
  // rg honors .gitignore exactly the way the suggested Grep does, so only the
  // grep/egrep forms answer a different file set. Flagging rg would put a false
  // statement in the refusal message.
  const divergesOnIgnoredFiles = tool !== 'rg'
  const flags: PatternFlags = {
    recursive: tool === 'rg',
    caseInsensitive: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    noFilename: false,
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
      case '-h':
        // Only on grep/egrep. ripgrep spells --no-filename in full and gives
        // `-h` to --help, so mapping the short form there would turn a request
        // for the manual into a search.
        if (tool === 'rg') return null
        flags.noFilename = true
        break
      case '--no-filename':
        // Presentation only — it drops the `file:` prefix grep puts on every
        // line. Checked against the target below, since Grep always prefixes.
        flags.noFilename = true
        break
      case '--no-heading':
        // rg-only, and a no-op for this mapping: without it rg groups matches
        // under a filename header, with it (and by default when its output is
        // a pipe) it prints the `file:line:` form Grep already returns. Not a
        // grep flag at all, so accepting it there would map a command the
        // shell would have rejected.
        if (tool !== 'rg') return null
        break
      case '-E':
      case '--extended-regexp':
        // Not a real rg flag; on grep and egrep it selects the dialect Grep is
        // going to hand to rg anyway.
        if (tool === 'rg') return null
        dialect = 'ere'
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
  if (paths.length === 1 && targetsExcludedVcsDir(paths[0]!)) return null
  // The pattern reaches rg unchanged, so a dialect Grep cannot reproduce has to
  // stand the whole command down rather than search for something else.
  if (
    dialect === 'bre'
      ? BRE_DIVERGENT_RE.test(pattern) || hasDivergentBreAnchors(pattern)
      : hasDivergentEreSyntax(pattern)
  ) {
    return null
  }

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

  // A recursive search over the cwd or a directory WALKS A TREE, and that is
  // where the suggested Grep stops being result-identical: ripgrep honors
  // .gitignore while grep -r walks everything (measured on this repo:
  // `grep -rn TODO .` answers 3756 lines, `rg -n TODO .` 171 — 22x fewer;
  // over src/ the two agree exactly). The redirect still fires — the tree
  // form is the case the feature exists for — but the refusal message must
  // say the file set differs, so the flag travels on the call.
  let walksTree = false
  let targetIsDirectory = false
  let path: string | undefined
  if (paths.length === 1) {
    // Resolved only to prove it exists — Grep is happy with the relative form
    // the model already wrote, and echoing that keeps the suggestion readable.
    // A directory is a legal target only when the search is recursive: plain
    // `grep TODO src` prints `grep: src: Is a directory` and matches nothing,
    // so mapping it to a recursive Grep would invent results.
    const abs = toAbsolute(paths[0]!, cwd)
    try {
      const stats = statSync(abs)
      if (!flags.recursive && !stats.isFile()) return null
      targetIsDirectory = stats.isDirectory()
      walksTree = divergesOnIgnoredFiles && flags.recursive && targetIsDirectory
    } catch {
      return null
    }
    path = paths[0]!
  } else if (!flags.recursive) {
    // Non-recursive grep with no path reads stdin — that is a filter on someone
    // else's output, not a search of the tree.
    return null
  } else {
    walksTree = divergesOnIgnoredFiles
  }

  // `-h` asked for output WITHOUT filenames and Grep always prefixes them, so
  // it is only accepted where the answer can name a single file anyway: one
  // path, and that path a regular file. Over a tree — or over stdin-less
  // recursion with no path at all — the suggestion would answer with the
  // prefixes the model explicitly suppressed.
  if (flags.noFilename && (paths.length !== 1 || targetIsDirectory)) return null

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
        walksTree: walksTree || undefined,
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
  let sawTypeFile = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-')) {
      // Positional roots only come before the predicates.
      if (namePattern !== undefined) return null
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
      case '-type': {
        const value = args[++i]
        // Glob returns files. `-type d` and `-type l` have no spelling.
        if (value !== 'f') return null
        sawTypeFile = true
        break
      }
      default:
        // -exec, -delete, -maxdepth, -mtime, -size, -newer, -iname, -o, -not …
        // and -path, which LOOKS translatable and is not: its wildcards cross
        // `/`, ripgrep's globset `*` stops at one segment, so `-path "./src/*"`
        // would become a Glob over direct children only — silently narrower.
        return null
    }
  }
  if (roots.length > 1) return null
  if (namePattern === undefined && !sawTypeFile) return null

  const root = roots[0]
  if (root !== undefined && !resolveDirectory(root, cwd)) return null

  // -name matches the basename at any depth.
  const pattern = namePattern !== undefined ? `**/${namePattern}` : '**/*'

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
      return parseGrep(argv, cwd, 'grep')
    case 'egrep':
      return parseGrep(argv, cwd, 'egrep')
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
  // `a || b` runs b only when a fails, and that is exactly the trap: both
  // branches map cleanly, so suggesting both hands back a file the shell would
  // never have printed.
  if (walked.segments.some(segment => segment.joinedBy === '||')) return null

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

  // Only a SINGLE call has a window to narrow — folding a selector into
  // several Reads would change what the model gets back, and Glob has nothing
  // to fold it into. Grep does: `grep -n foo f.ts | head -20` is the most
  // common shape the shell is still being used for, and `head_limit`/`offset`
  // spell it exactly.
  const only = head.calls.length === 1 ? head.calls[0] : undefined
  const windowable =
    only && (only.tool === 'Read' || only.tool === 'Grep') ? only : undefined

  let window: LineWindow = head.window ?? IDENTITY_WINDOW
  for (const segment of group.slice(1)) {
    if (!windowable) return null
    const role = classifySegment(segment, cwd)
    if (!role || role.kind !== 'selector') return null
    window = composeWindow(window, role.window)
    if (window.limit !== undefined && window.limit < 1) return null
  }

  const calls = (windowable ? [applyWindow(windowable, window)] : head.calls).map(
    withFullBody,
  )
  return { text: group.map(segment => segment.text).join(' | '), calls }
}

/**
 * A Read with no offset and no limit is the exact shape FileReadTool pivots to
 * an outline for (the pivot triggers on offset===1 && limit===undefined once a
 * code file passes its line/char thresholds). The command being replaced —
 * `cat f`, `nl f`, `grep -n "" f` — promised the body, so ask for the body.
 */
function withFullBody(call: SuggestedCall): SuggestedCall {
  if (call.tool !== 'Read') return call
  if (call.offset !== undefined || call.limit !== undefined) return call
  return { ...call, view: 'full' }
}

function applyWindow(
  call: Extract<SuggestedCall, { tool: 'Read' | 'Grep' }>,
  window: LineWindow,
): SuggestedCall {
  if (call.tool === 'Grep') {
    // Grep's `offset` skips entries and counts from 0; the window counts lines
    // from 1. The trim also lands on rg's ordering rather than grep's — for a
    // tree walk that is the same divergence `walksTree` already announces.
    const next = { ...call }
    if (window.offset > 1) next.offset = window.offset - 1
    if (window.limit !== undefined) next.head_limit = window.limit
    return next
  }
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
 * This lane's own refusal memo — see `../shared/redirect.ts` for the eviction
 * reasoning and for why each redirect keeps a separate instance.
 */
const memo = createOneShotMemo(MEMO_LIMIT)

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
 * Safe to consume the one-shot here because `validateInput` runs once per tool
 * call at each of its call sites — `services/tools/toolExecution.ts` and
 * `entrypoints/mcp.ts`. The memo is module-level, so PROCESS-WIDE and shared
 * by both entrypoints; under MCP the refusal surfaces as a thrown Error
 * carrying this same message (mcp.ts wraps a failed validation in
 * `throw new Error`), not as a tool_result.
 */
export function shouldRedirectToTools(
  command: string,
  cwd: string,
  hasTool: (toolName: string) => boolean,
): RedirectAnalysis | null {
  const analysis = analyzeCommandForRedirect(command, cwd)
  if (!analysis) return null
  if (!analysis.targets.every(target => hasTool(TOOL_NAME[target]))) return null
  return memo.shouldRefuse(command) ? analysis : null
}

export function resetToolRedirectMemoForTesting(): void {
  memo.reset()
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export function renderToolRedirect(analysis: RedirectAnalysis): string {
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
  if (
    analysis.units.some(unit =>
      unit.calls.some(call => call.tool === 'Grep' && call.walksTree),
    )
  ) {
    lines.push(
      'Note: Grep honors .gitignore — the shell command would also have searched ignored files (node_modules, build output, vendored dirs); the suggested call skips them, and answers at most 250 entries unless you pass head_limit.',
    )
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
      if (call.view !== undefined) {
        args.push(`view: ${JSON.stringify(call.view)}`)
      }
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
      if (call.offset !== undefined) args.push(`offset: ${call.offset}`)
      if (call.head_limit !== undefined) {
        args.push(`head_limit: ${call.head_limit}`)
      }
      return `${GREP_TOOL_NAME}(${args.join(', ')})`
    }
    case 'Glob': {
      const args = [`pattern: ${JSON.stringify(call.pattern)}`]
      if (call.path !== undefined) args.push(`path: ${JSON.stringify(call.path)}`)
      return `${GLOB_TOOL_NAME}(${args.join(', ')})`
    }
  }
}
