/**
 * Turn taxonomy of the session-cache A/B transcripts: what each model request
 * of a session was FOR, and which requests a lever could have folded into the
 * one before. A request is one API response — the assistant entries sharing a
 * `message.id`, their tool_use blocks in the order written, each paired with
 * its tool_result.
 *
 * These rules are the census behind `.claudin/plans/synchronous-conjuring-creek.md`
 * ("O que os dados mostram"), validated on the 2026-09-24 -212723 and -231111
 * runs; `turn-taxonomy.ts` reproduces both of that census's reports number for
 * number. Changing a rule here changes the measure, so re-run both reports and
 * say so. The Bash parser was checked against Claude Code's own `bashEditDiff`
 * over the claude arm's ten sessions.
 *
 * Label, one per request, first match wins:
 *   FINAL   no tool call: a phase's closing summary
 *   META    bookkeeping only (ToolSearch, TodoWrite, Task*, plan mode, questions)
 *   REACT   the request before hit a hard error, and this one touches what failed
 *   COMMIT  git add / git commit
 *   VERIFY  a check — tests, typecheck, build, a manual run — that edits nothing
 *   EDIT    writes a project file; a Bash write counts, an edit undone inside
 *           the same request to prove that a test catches it does not
 *   ORIENT  the rest: reads, searches, git state
 *
 * Levers, a CEILING — the request did not need the result of the one before:
 *   M-chain       a VERIFY/COMMIT right after a clean EDIT or VERIFY
 *   M-toolsearch  a request right after a ToolSearch-only one, using what it loaded
 *   M-batch       an ORIENT whose every path and pattern was already known
 *   M-edit        an EDIT right after a clean EDIT, on files whose content was seen
 *
 * Mechanism metrics, per session: what the request-count A/B's gates read.
 *   chainResponses      responses with an EDIT call and, later in the same
 *                       response, a VERIFY call
 *   gitReadWithCheck    responses carrying a VERIFY call and a read-only git
 *                       call (status/diff/log/show, Git tool or Bash) together
 *   multiKindPatch      applied (not errored) Patch/apply_patch calls whose
 *                       files mix non-test source and tests; multiKindPatchDoc
 *                       counts those also carrying a doc (README.md)
 *   skipped             tool_results starting `<tool_use_error>Skipped:`, the
 *                       same-response guard's refusals
 *   commitAfterFailure  git commits that ran after an earlier call of the same
 *                       response failed: an error result, a nonzero exitCode
 *                       from RunTests/Typecheck/Build, a stripped `| tail`'s
 *                       `exit="N"` marker, or failing tests in the output
 *   gitOnlyCalls        the commit protocol's own requests: responses whose
 *                       every call is git — the Git tool, or a Bash whose
 *                       every command is git or a head/tail its output is
 *                       piped into — and that edit nothing (a git restore,
 *                       checkout or stash is an edit); a FINAL has no call
 *   globReads           Read calls naming a glob (an unescaped `*` `?` `[`
 *                       `{`) in file_paths; globReadFiles counts the files
 *                       their results showed, one `==> path <==` header each
 *   firstEditTurn       phase 1's responses before its first edit, all of them
 *                       when it never edits: `resume` measured on phase 1
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseJsonl } from './cliUsage'

type Json = Record<string, unknown>

const isRec = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export type ToolUse = {
  id: string
  name: string
  input: Json
  /** The tool_result's text, blocks joined by newlines. */
  result: string
  isError: boolean
  hasResult: boolean
  /** The result entry's `toolUseResult` — the tool's structured output — when present. */
  structured?: unknown
}

export type Call = {
  /** 1-based index in the main thread. */
  k: number
  id: string
  /** 1 until the session's second human prompt, 2 from it on. */
  phase: 1 | 2
  model: string
  texts: string[]
  thinking: boolean
  /** In the order the response wrote them. */
  tools: ToolUse[]
  /** Index into `Session.entries` of this request's first entry. */
  entryIndex: number
  usage: { in: number; out: number; cR: number; cW: number }
}

export type Session = {
  /** The directory the session ran in; tool paths are made relative to it. */
  ws: string
  calls: Call[]
  /** The human prompts, in order. */
  prompts: string[]
  /** Every main-thread file's entries, the oldest file first. */
  entries: Json[]
  subagentCalls: number
}

const HARNESS_PROMPT_RE = /^<(command-|local-command|system-reminder)/
const INTERRUPTED_RE = /^\[Request interrupted/

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (isRec(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : isRec(b) && b.type === 'image' ? '[image]' : ''))
    .join('\n')
}

/** The text of a human prompt: a user entry with no tool_result that is neither meta nor a harness caveat. */
function humanPrompt(e: Json): string | null {
  const msg = e.message
  if (e.type !== 'user' || !isRec(msg) || e.isMeta || e.isSidechain) return null
  const c = msg.content
  if (Array.isArray(c) && c.some(b => isRec(b) && b.type === 'tool_result')) return null
  const text = contentText(c)
  const trimmed = text.trim()
  if (!trimmed || HARNESS_PROMPT_RE.test(trimmed) || INTERRUPTED_RE.test(trimmed)) return null
  return text
}

/**
 * One session's requests from its transcript entries: assistant entries
 * grouped by `message.id` (a `<synthetic>` model and sidechain entries are not
 * requests), each tool_use paired with its tool_result.
 */
export function sessionFromEntries(entries: Json[], ws: string, subagentCalls = 0): Session {
  const results = new Map<string, { text: string; isError: boolean; structured?: unknown }>()
  for (const e of entries) {
    const msg = e.message
    if (e.type !== 'user' || !isRec(msg) || e.isSidechain) continue
    const blocks = list(msg.content).filter(isRec).filter(b => b.type === 'tool_result')
    for (const b of blocks) {
      const id = b.tool_use_id
      if (typeof id !== 'string' || results.has(id)) continue
      results.set(id, {
        text: contentText(b.content),
        isError: b.is_error === true,
        structured: blocks.length === 1 ? e.toolUseResult : undefined,
      })
    }
  }

  const calls: Call[] = []
  const byId = new Map<string, Call>()
  const prompts: string[] = []
  let phase: 1 | 2 = 1
  entries.forEach((e, idx) => {
    if (e.isSidechain) return
    const prompt = humanPrompt(e)
    if (prompt !== null) {
      prompts.push(prompt)
      phase = prompts.length >= 2 ? 2 : 1
      return
    }
    const m = e.message
    if (e.type !== 'assistant' || !isRec(m)) return
    const id = m.id
    if (typeof id !== 'string' || m.model === '<synthetic>') return
    let call = byId.get(id)
    if (!call) {
      call = { k: calls.length + 1, id, phase, model: String(m.model ?? ''), texts: [], thinking: false, tools: [], entryIndex: idx, usage: { in: 0, out: 0, cR: 0, cW: 0 } }
      byId.set(id, call)
      calls.push(call)
    }
    const u: Json = isRec(m.usage) ? m.usage : {}
    call.usage.in = Math.max(call.usage.in, Number(u.input_tokens ?? 0))
    call.usage.out = Math.max(call.usage.out, Number(u.output_tokens ?? 0))
    call.usage.cR = Math.max(call.usage.cR, Number(u.cache_read_input_tokens ?? 0))
    call.usage.cW = Math.max(call.usage.cW, Number(u.cache_creation_input_tokens ?? 0))
    for (const b of list(m.content)) {
      if (!isRec(b)) continue
      const text = b.text
      if (b.type === 'text' && typeof text === 'string' && text.trim()) {
        // Claude Code may flush a prefix snapshot, then the full text: keep the longest.
        const texts = call.texts
        const i = texts.findIndex(t => text.startsWith(t) || t.startsWith(text))
        if (i >= 0) texts[i] = text.length > texts[i]!.length ? text : texts[i]!
        else texts.push(text)
      }
      if (b.type === 'thinking' || b.type === 'redacted_thinking') call.thinking = true
      const useId = b.id
      if (b.type === 'tool_use' && typeof useId === 'string' && !call.tools.some(t => t.id === useId)) {
        const r = results.get(useId)
        call.tools.push({
          id: useId,
          name: String(b.name ?? ''),
          input: isRec(b.input) ? b.input : {},
          result: r?.text ?? '',
          isError: r?.isError ?? false,
          hasResult: !!r,
          structured: r?.structured,
        })
      }
    }
  })
  return { ws, calls, prompts, entries, subagentCalls }
}

function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsonlUnder(p))
    else if (entry.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** API calls (distinct non-synthetic message ids) over transcript files, counted per file. */
function countCalls(files: string[]): number {
  let n = 0
  for (const f of files) {
    const ids = new Set<string>()
    for (const e of parseJsonl(readFileSync(f, 'utf8'))) {
      const m = e.message
      const id = isRec(m) ? m.id : undefined
      if (e.type === 'assistant' && isRec(m) && typeof id === 'string' && m.model !== '<synthetic>') ids.add(id)
    }
    n += ids.size
  }
  return n
}

/**
 * A session from its projects directory. One session can span several
 * top-level `.jsonl` files (a `--resume` into a new process): they are joined
 * in order of their first timestamp. Sub-agent transcripts, in the
 * directories beside them, are only counted.
 */
export function loadSessionDir(dir: string, ws: string): Session | null {
  if (!existsSync(dir)) return null
  const mains = readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const entries = parseJsonl(readFileSync(join(dir, f), 'utf8'))
      return { entries, t: String(entries.find(e => typeof e.timestamp === 'string')?.timestamp ?? '') }
    })
    .sort((a, b) => a.t.localeCompare(b.t))
  const subagentFiles = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .flatMap(d => jsonlUnder(join(dir, d.name)))
  return sessionFromEntries(mains.flatMap(m => m.entries), ws, countCalls(subagentFiles))
}

// ---------------------------------------------------------------------------
// The session-cache A/B's layout
// ---------------------------------------------------------------------------

/** Where `session-cache-ab.ts` puts each arm's workspace: `<root>/<stamp>/<arm>-r<rep>`. */
const BENCH_ROOT = '/tmp/session-cache-ab'
const NON_ALNUM_RE = /[^a-zA-Z0-9]/g
const DIGITS_RE = /^\d+$/
const RUN_STAMP_RE = /^-tmp-session-cache-ab-(\d{8}-\d{6})-/

/** The projects-directory name both CLIs derive from a cwd (`sanitizePath`; these paths are short enough to need no hash). */
const projectDirName = (cwd: string): string => cwd.replace(NON_ALNUM_RE, '-')

/** Claude Code writes under ~/.claude, every claudin arm under ~/.claudin. */
const projectsRoot = (arm: string, home: string): string => join(home, arm === 'claude' ? '.claude' : '.claudin', 'projects')

export const workspaceOf = (stamp: string, arm: string, rep: number): string => `${BENCH_ROOT}/${stamp}/${arm}-r${rep}`

/** The reps of one arm with a transcript directory, ascending. */
export function repsOf(stamp: string, arm: string, home = homedir()): number[] {
  const root = projectsRoot(arm, home)
  if (!existsSync(root)) return []
  const prefix = projectDirName(`${BENCH_ROOT}/${stamp}/${arm}-r`)
  const reps: number[] = []
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue
    const rep = name.slice(prefix.length)
    if (DIGITS_RE.test(rep)) reps.push(Number(rep))
  }
  return reps.sort((a, b) => a - b)
}

/** The run stamps (`20260924-231111`) with transcripts that equal or end with `stamp`. */
export function stampsMatching(stamp: string, home = homedir()): string[] {
  const found = new Set<string>()
  for (const root of [projectsRoot('claudin', home), projectsRoot('claude', home)]) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const full = RUN_STAMP_RE.exec(name)?.[1]
      if (full && full.endsWith(stamp)) found.add(full)
    }
  }
  return [...found].sort()
}

export function loadSession(stamp: string, arm: string, rep: number, home = homedir()): Session | null {
  const ws = workspaceOf(stamp, arm, rep)
  return loadSessionDir(join(projectsRoot(arm, home), projectDirName(ws)), ws)
}

// ---------------------------------------------------------------------------
// Shell: enough of a tokenizer for the commands in these transcripts — quotes,
// escapes, $(...) and backticks kept as opaque word text, operators,
// redirects, and heredoc bodies, attached to the segment that opened them.
// ---------------------------------------------------------------------------

export type Redirect = { fd: string; op: string; target: string }
export type Segment = {
  words: string[]
  redirects: Redirect[]
  heredoc: string | null
  /** The operator that joined this segment to the previous one. */
  opBefore: string | null
}

const LEADING_TABS_RE = /^\t+/
const HEREDOC_DELIM_END_RE = /[\s;&|<>()]/
const SINGLE_DIGIT_RE = /^\d$/
const FD_DUP_CHAR_RE = /[\d-]/

/** `s[i]` is `(`: the index of the matching `)`. */
function matchParen(s: string, i: number): number {
  let depth = 0
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === "'") {
      const e = s.indexOf("'", j + 1)
      j = e < 0 ? s.length : e
      continue
    }
    if (c === '"') {
      j++
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') j++
        j++
      }
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j
    }
  }
  return s.length - 1
}

export function parseShell(cmd: string): Segment[] {
  const segs: Segment[] = []
  let cur: Segment = { words: [], redirects: [], heredoc: null, opBefore: null }
  let word: string | null = null
  let pendingRedirect: { fd: string; op: string } | null = null
  const pendingHeredocs: { delim: string; strip: boolean; seg: Segment }[] = []
  const n = cmd.length
  let i = 0

  const endWord = () => {
    if (word === null) return
    if (pendingRedirect) {
      cur.redirects.push({ ...pendingRedirect, target: word })
      pendingRedirect = null
    } else cur.words.push(word)
    word = null
  }
  const endSeg = (op: string) => {
    endWord()
    if (cur.words.length || cur.redirects.length || cur.heredoc !== null || pendingHeredocs.some(h => h.seg === cur)) {
      segs.push(cur)
      cur = { words: [], redirects: [], heredoc: null, opBefore: op }
    } else if (op !== '\n') cur.opBefore = op
  }
  const readHeredocBodies = () => {
    // i points just after a newline
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift()!
      const lines: string[] = []
      while (i < n) {
        let e = cmd.indexOf('\n', i)
        if (e < 0) e = n
        const line = cmd.slice(i, e)
        i = e + 1
        const cmp = h.strip ? line.replace(LEADING_TABS_RE, '') : line
        if (cmp.trim() === h.delim) break
        lines.push(line)
      }
      h.seg.heredoc = (h.seg.heredoc ?? '') + lines.join('\n')
    }
  }

  while (i < n) {
    const c = cmd[i]!
    if (c === '\\') {
      if (cmd[i + 1] === '\n') {
        i += 2
        continue
      }
      word = (word ?? '') + (cmd[i + 1] ?? '')
      i += 2
      continue
    }
    if (c === "'") {
      let e = cmd.indexOf("'", i + 1)
      if (e < 0) e = n
      word = (word ?? '') + cmd.slice(i + 1, e)
      i = e + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let out = ''
      while (j < n && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < n && '"\\$`\n'.includes(cmd[j + 1]!)) {
          out += cmd[j + 1]
          j += 2
          continue
        }
        if (cmd[j] === '$' && cmd[j + 1] === '(') {
          const e = matchParen(cmd, j + 1)
          out += cmd.slice(j, e + 1)
          j = e + 1
          continue
        }
        out += cmd[j]
        j++
      }
      word = (word ?? '') + out
      i = j + 1
      continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      const e = matchParen(cmd, i + 1)
      word = (word ?? '') + cmd.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === '`') {
      let e = cmd.indexOf('`', i + 1)
      if (e < 0) e = n
      word = (word ?? '') + cmd.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === '#' && word === null) {
      const e = cmd.indexOf('\n', i)
      i = e < 0 ? n : e
      continue
    }
    if (c === '\n') {
      const hasContent = word !== null || cur.words.length > 0 || cur.redirects.length > 0
      if (hasContent) endSeg(';')
      i++
      if (pendingHeredocs.length) readHeredocBodies()
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === ';') {
      endSeg(';')
      i += cmd[i + 1] === ';' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (cmd[i + 1] === '&') {
        endSeg('&&')
        i += 2
        continue
      }
      if (cmd[i + 1] === '>') {
        endWord()
        const app = cmd[i + 2] === '>'
        pendingRedirect = { fd: '&', op: app ? '>>' : '>' }
        i += app ? 3 : 2
        continue
      }
      endSeg('&')
      i++
      continue
    }
    if (c === '|') {
      if (cmd[i + 1] === '|') {
        endSeg('||')
        i += 2
        continue
      }
      endSeg('|')
      i += cmd[i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      // Grouping is a boundary; `{` and `}` only as standalone words.
      if ((c === '{' || c === '}') && word !== null) {
        word += c
        i++
        continue
      }
      endSeg(';')
      i++
      continue
    }
    if (c === '>' || c === '<') {
      let fd = ''
      if (word !== null && SINGLE_DIGIT_RE.test(word)) {
        fd = word
        word = null
      } else endWord()
      if (c === '<') {
        if (cmd[i + 1] === '<' && cmd[i + 2] === '<') {
          // here-string: the next word is the input
          pendingRedirect = { fd, op: '<<<' }
          i += 3
          continue
        }
        if (cmd[i + 1] === '<') {
          i += 2
          let strip = false
          if (cmd[i] === '-') {
            strip = true
            i++
          }
          while (cmd[i] === ' ' || cmd[i] === '\t') i++
          let delim = ''
          while (i < n && !HEREDOC_DELIM_END_RE.test(cmd[i]!)) {
            if (cmd[i] === "'" || cmd[i] === '"') {
              const q = cmd[i]!
              const e = cmd.indexOf(q, i + 1)
              delim += cmd.slice(i + 1, e < 0 ? n : e)
              i = e < 0 ? n : e + 1
              continue
            }
            if (cmd[i] === '\\') {
              i++
              continue
            }
            delim += cmd[i]
            i++
          }
          pendingHeredocs.push({ delim, strip, seg: cur })
          continue
        }
        if (cmd[i + 1] === '(') {
          // process substitution <( ... )
          const e = matchParen(cmd, i + 1)
          word = (word ?? '') + cmd.slice(i, e + 1)
          i = e + 1
          continue
        }
        pendingRedirect = { fd, op: '<' }
        i++
        continue
      }
      // '>'
      if (cmd[i + 1] === '(') {
        const e = matchParen(cmd, i + 1)
        i = e + 1
        continue
      }
      let op = '>'
      let j = i + 1
      if (cmd[j] === '>') {
        op = '>>'
        j++
      }
      if (cmd[j] === '&') {
        // >&2, 2>&1: fd duplication, no file
        j++
        while (j < n && FD_DUP_CHAR_RE.test(cmd[j]!)) j++
        i = j
        continue
      }
      if (cmd[j] === '|') j++
      pendingRedirect = { fd, op }
      i = j
      continue
    }
    word = (word ?? '') + c
    i++
  }
  endSeg(';')
  // An unterminated heredoc keeps what it had.
  for (const h of pendingHeredocs) h.seg.heredoc = h.seg.heredoc ?? ''
  return segs
}

// ---------------------------------------------------------------------------
// Classification: per tool, then per request
// ---------------------------------------------------------------------------

export type Kind = 'META' | 'COMMIT' | 'VERIFY' | 'EDIT' | 'ORIENT'
export type Label = 'FINAL' | 'META' | 'REACT' | 'COMMIT' | 'VERIFY' | 'EDIT' | 'ORIENT'

export type ToolInfo = {
  name: string
  kind: Kind
  meta: boolean
  commits: boolean
  verifies: boolean
  mutates: boolean
  /** `python -c`, `bun -e`, a scratch script: a computation that writes nothing. */
  computes: boolean
  testRun: boolean
  revertCheck: boolean
  /** Project files written, created ones included (relative paths). */
  editTargets: string[]
  created: string[]
  /** Project files whose content the result showed (may be globs). */
  readTargets: string[]
  /** Every project path the input names (may be globs). */
  paths: string[]
  /** Search patterns (grep, rg, Grep). */
  patterns: string[]
  isResubmit: boolean
  summary: string
  heads: string[]
  /** The subcommand of every git command the call runs, global options skipped. */
  gitSubs: string[]
  /** Bash: what the parser alone concluded, before Claude Code's bashEditDiff. */
  parserMutates?: boolean
  /** Bash on Claude Code: the files its bashEditDiff reports. */
  diffFiles?: string[]
}

export type CallInfo = {
  call: Call
  tools: ToolInfo[]
  mutates: boolean
  verifies: boolean
  commits: boolean
  revertCheck: boolean
  hardErr: boolean
  softFail: boolean
  /** The label before the REACT rule. */
  base: Label
  label: Label
  reactCat: string | null
  softReact: boolean
  /** M-chain, M-toolsearch, M-batch, M-edit, plus M-chain+stage and X-verify-after-orient. */
  levers: string[]
  notes: string[]
}

/** The session-cache A/B's pristine project, as `.tpl` files. */
const SESSION_CACHE_PROJECT = join(import.meta.dir, '__fixtures__', 'session-cache-ab', 'project')
const TPL_SUFFIX_RE = /\.tpl$/

const pristineByFixture = new Map<string, string[]>()
/** The files of a `.tpl` fixture tree, relative and without the suffix: what a session edits without creating. */
function pristineFiles(fixtureDir: string): string[] {
  const cached = pristineByFixture.get(fixtureDir)
  if (cached) return cached
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      else out.push((rel ? `${rel}/` : '') + e.name.replace(TPL_SUFFIX_RE, ''))
    }
  }
  walk(fixtureDir, '')
  pristineByFixture.set(fixtureDir, out)
  return out
}

const fixtureText = new Map<string, string | null>()
/** Whether a tool result shows a pristine fixture file whole: its first and last 80 characters. */
function shownWhole(fixtureDir: string, rel: string, result: string): boolean {
  const path = join(fixtureDir, `${rel}.tpl`)
  if (!fixtureText.has(path)) fixtureText.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null)
  const text = fixtureText.get(path)
  if (!text) return false
  const body = text.trim()
  return result.includes(body.slice(0, 80)) && result.includes(body.slice(-80))
}

const PATHLIKE_RE = /^[\w@.+\-\/*?\[\]{},]+$/
const EXT_RE = /\.(ts|tsx|js|mjs|cjs|json|md|txt|lock|bak|ya?ml|sh)$/i
const DOT_SLASH_RE = /^\.\//
const LEADING_DIGIT_RE = /^\d/

class Ctx {
  cwdProject = true
  constructor(readonly ws: string) {}
  /** The relative project path a token names, or null when it names none. */
  rel(token: string, requirePathLike = true): string | null {
    let t = token.trim()
    if (!t || t === '-' || t.startsWith('-') || t.startsWith('$') || t.startsWith('~') || t.startsWith('&')) return null
    if (t.startsWith('/dev/')) return null
    if (t.startsWith(this.ws + '/')) t = t.slice(this.ws.length + 1)
    else if (t === this.ws) return '.'
    else if (t.startsWith('/')) return null
    else if (!this.cwdProject) return null
    t = t.replace(DOT_SLASH_RE, '')
    if (requirePathLike && (!PATHLIKE_RE.test(t) || !(t.includes('/') || EXT_RE.test(t)))) return null
    if (LEADING_DIGIT_RE.test(t) && !t.includes('/')) return null
    if (t.startsWith('../')) return null
    return t
  }
}

const REGEX_SPECIAL_RE = /[.+^$()|[\]\\]/g
const GLOB_CHAR_RE = /[*?{[]/

function globRe(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const e = glob.indexOf('}', i)
      re += '(' + glob.slice(i + 1, e).split(',').map(s => s.replace(REGEX_SPECIAL_RE, '\\$&')).join('|') + ')'
      i = e
    } else re += c.replace(REGEX_SPECIAL_RE, '\\$&')
  }
  return new RegExp('^' + re + '$')
}
const isGlob = (p: string): boolean => GLOB_CHAR_RE.test(p)
/** Do two path lists (globs allowed) name a common file? */
function overlap(a: string[], b: string[], universe: Set<string>): boolean {
  const expand = (p: string) => (isGlob(p) ? [...universe].filter(f => globRe(p).test(f)) : [p])
  const A = new Set(a.flatMap(expand))
  if (!A.size) return false
  for (const p of b.flatMap(expand)) if (A.has(p)) return true
  return false
}

// --- Bash -------------------------------------------------------------------

const LINTERS = new Set(['tsc', 'eslint', 'biome', 'prettier', 'oxlint', 'vitest', 'jest', 'tsgo'])
const READERS = new Set(['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'awk', 'jq', 'od', 'xxd'])
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag'])
const LEAD_KEYWORDS = new Set(['do', 'then', 'else', '!', 'time', 'exec', 'sudo', 'command'])
const CONTROL_WORDS = new Set(['while', 'until', 'if', 'case', 'done', 'fi', 'esac', 'elif'])
const GIT_VALUE_OPTIONS = new Set(['-C', '-c'])
const GIT_HISTORY_EDITS = new Set(['reset', 'apply', 'rm', 'mv', 'clean', 'revert', 'cherry-pick', 'merge', 'rebase'])
const BUN_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-'])
const PM_CHECK_SUBS = new Set(['test', 't', 'run', 'exec'])
const COPIERS = new Set(['cp', 'mv', 'install'])
const FS_WRITERS = new Set(['rm', 'touch', 'mkdir', 'ln', 'chmod', 'truncate', 'rmdir'])
const PM_HEADS = new Set(['npm', 'pnpm', 'yarn'])
const NPX_HEADS = new Set(['bunx', 'npx', 'pnpx'])
const REDIRECT_FDS = new Set(['1', '2', '&'])
const ASSIGNMENT_RE = /^\w+=/
const LOOP_VAR_RE = /^\$\{?(\w+)\}?$/
const SCRIPT_EXT_RE = /\.(ts|tsx|js|mjs)$/
const INTERPRETER_RE = /^(python3?|node|ruby)$/
const PERL_INPLACE_RE = /^-\w*i/
const SED_INPLACE_RE = /^-[a-zA-Z]*i/
const GREP_VALUE_FLAG_RE = /^-[ABCmd]$/
const SED_SCRIPT_RE = /^s(.)(.*?)\1(.*?)\1[gip0-9]*$/s
const WRITER_RE =
  /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"](?:w|a|x|r\+|w\+|a\+)b?['"]|\.write_text\(|writeFileSync\(|appendFileSync\(|Bun\.write\(|shutil\.(?:copy|move)|os\.(?:remove|rename|replace)\(/
const WRITER_ALL_RE = new RegExp(WRITER_RE.source, 'g')
const CODE_PATH_RE = /['"`]([\w.\-\/]+\.(?:ts|tsx|js|json|md))['"`]/g
const CODE_READ_RE = /(?:require|open|readFileSync|loadCatalog|json\.load\(open)\(\s*['"`]([^'"`]+)['"`]/g
const OPEN_WRITE_RE = /\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(?:mode\s*=\s*)?['"](?:w|a|x|r\+|w\+|a\+)b?['"]/g

type SedScript = { a: string; b: string } | null
function sedScript(s: string): SedScript {
  const m = SED_SCRIPT_RE.exec(s)
  return m ? { a: m[2]!, b: m[3]! } : null
}

export type BashInfo = Omit<ToolInfo, 'name' | 'kind' | 'meta' | 'summary' | 'isResubmit'>

export function analyzeBash(command: string, ws: string, universe: Set<string>): BashInfo {
  const ctx = new Ctx(ws)
  const segs = parseShell(command)
  const info: BashInfo = {
    commits: false,
    verifies: false,
    mutates: false,
    computes: false,
    testRun: false,
    revertCheck: false,
    editTargets: [],
    created: [],
    readTargets: [],
    paths: [],
    patterns: [],
    heads: [],
    gitSubs: [],
  }
  const mutations: { kind: string; target: string | null; sed?: SedScript }[] = []
  const cps: { src: string; dst: string; dstProject: boolean }[] = []
  const loops = new Map<string, string[]>()
  const addPath = (tok: string, asRead = false) => {
    const r = ctx.rel(tok)
    if (!r) return null
    info.paths.push(r)
    if (asRead) info.readTargets.push(r)
    return r
  }
  const expandVar = (w: string): string[] => {
    const m = LOOP_VAR_RE.exec(w)
    return m && loops.has(m[1]!) ? loops.get(m[1]!)! : [w]
  }
  const codeWrites = (code: string): boolean => {
    const lits = [...code.matchAll(CODE_PATH_RE)].map(m => ctx.rel(m[1]!)).filter((p): p is string => !!p)
    const requires = [...code.matchAll(CODE_READ_RE)].map(m => ctx.rel(m[1]!)).filter((p): p is string => !!p)
    info.paths.push(...lits, ...requires)
    if (!WRITER_RE.test(code)) return false
    // open('<literal>', 'w') sites: when every write names a literal outside the project, it writes scratch only.
    const sites = [...code.matchAll(OPEN_WRITE_RE)].map(m => m[2]!)
    const allWrites = code.match(WRITER_ALL_RE) ?? []
    if (sites.length && sites.length === allWrites.length && sites.every(p => !ctx.rel(p, false))) return false
    const literalTargets = sites.map(p => ctx.rel(p, false)).filter((p): p is string => !!p)
    const ts = literalTargets.length ? literalTargets : lits.length ? lits : [null]
    for (const t of ts) mutations.push({ kind: 'code-writer', target: t })
    return true
  }

  for (const seg of segs) {
    const words = [...seg.words]
    while (words.length && LEAD_KEYWORDS.has(words[0]!)) words.shift()
    // `S=/tmp/...` or `R=$ws`: an assignment, maybe holding a path
    while (words.length && ASSIGNMENT_RE.test(words[0]!)) words.shift()
    const head = words[0]
    const args = words.slice(1)
    for (const r of seg.redirects) {
      if (r.op !== '>' && r.op !== '>>') continue
      if (r.fd && !REDIRECT_FDS.has(r.fd)) continue
      const t = ctx.rel(r.target, false)
      if (t && t !== '.') {
        mutations.push({ kind: 'redirect', target: t })
        info.paths.push(t)
      }
    }
    if (!head) continue
    info.heads.push(head === 'git' || head === 'bun' || head === 'npm' ? `${head} ${args.find(a => !a.startsWith('-')) ?? ''}`.trim() : head)
    if (head === 'for' || head === 'select') {
      if (args.indexOf('in') === 1) {
        const items = args.slice(2)
        loops.set(args[0]!, items)
        for (const w of items) addPath(w)
      }
      continue
    }
    if (CONTROL_WORDS.has(head)) continue
    if (head === 'cd') {
      const d = args[0]
      if (!d || d === '-' || d === '~') ctx.cwdProject = true
      else if (d.startsWith(ws)) ctx.cwdProject = true
      else if (d.startsWith('/') || d.startsWith('$') || d.startsWith('~')) ctx.cwdProject = false
      continue
    }
    if (head === 'git') {
      let j = 0
      while (j < args.length && args[j]!.startsWith('-')) j += GIT_VALUE_OPTIONS.has(args[j]!) ? 2 : 1
      const sub = args[j] ?? ''
      const rest = args.slice(j + 1)
      info.gitSubs.push(sub)
      if (sub === 'add' || sub === 'commit') {
        info.commits = true
        for (const w of rest) addPath(w)
      } else if (sub === 'stash') {
        const op = rest.find(a => !a.startsWith('-')) ?? 'push'
        if (op === 'list' || op === 'show') continue
        mutations.push({ kind: op === 'pop' || op === 'apply' ? 'stash-pop' : 'stash-push', target: null })
      } else if (sub === 'checkout' || sub === 'restore') {
        const ps = rest
          .filter(a => !a.startsWith('-'))
          .map(a => ctx.rel(a))
          .filter((a): a is string => !!a)
        if (ps.length || rest.includes('--') || sub === 'restore') {
          for (const p of ps) mutations.push({ kind: 'git-checkout', target: p })
          if (!ps.length) mutations.push({ kind: 'git-checkout', target: null })
          info.paths.push(...ps)
        }
      } else if (GIT_HISTORY_EDITS.has(sub)) {
        mutations.push({ kind: `git-${sub}`, target: null })
      } else {
        for (const w of rest) addPath(w)
      }
      continue
    }
    if (head === 'bun') {
      const a0 = args[0] ?? ''
      const script = a0 === 'run' ? (args[1] ?? '') : a0
      if (a0 === 'test') {
        info.verifies = true
        info.testRun = true
        for (const w of args.slice(1)) addPath(w)
      } else if ((a0 === 'run' || (a0 && !a0.startsWith('-'))) && SCRIPT_EXT_RE.test(script) && !ctx.rel(script)) {
        info.computes = true // a scratch script: a computation, not a check of the project
      } else if (a0 === 'run') {
        info.verifies = true
        if (args[1] === 'test') info.testRun = true
        for (const w of args.slice(1)) addPath(w)
      } else if (a0 === 'x' && args.slice(1).some(a => LINTERS.has(a))) info.verifies = true
      else if (BUN_EVAL_FLAGS.has(a0)) {
        const code = a0 === '-' ? (seg.heredoc ?? '') : (args[1] ?? '')
        if (!codeWrites(code)) info.computes = true
      } else if (a0 && !a0.startsWith('-')) {
        const r = ctx.rel(a0)
        if (r) {
          info.verifies = true // `bun src/cli.ts …`: a manual run of the project
          info.paths.push(r)
        }
      }
      continue
    }
    if (NPX_HEADS.has(head)) {
      if (args.some(a => LINTERS.has(a))) info.verifies = true
      continue
    }
    if (LINTERS.has(head)) {
      info.verifies = true
      for (const w of args) addPath(w)
      continue
    }
    if (PM_HEADS.has(head)) {
      if (PM_CHECK_SUBS.has(args[0] ?? '')) info.verifies = true
      if ((args[0] ?? '') === 'test' || args[1] === 'test') info.testRun = true
      continue
    }
    if (INTERPRETER_RE.test(head)) {
      const cAt = args.findIndex(a => a === '-c' || a === '-e')
      const code = cAt >= 0 ? (args[cAt + 1] ?? '') : (seg.heredoc ?? '')
      if (!codeWrites(code)) info.computes = true
      continue
    }
    if (head === 'perl') {
      if (args.some(a => PERL_INPLACE_RE.test(a))) {
        for (const w of args.filter(a => !a.startsWith('-')).slice(1)) {
          const r = addPath(w)
          if (r) mutations.push({ kind: 'perl-i', target: r })
        }
      }
      continue
    }
    if (head === 'sed') {
      const inPlace = args.some(a => SED_INPLACE_RE.test(a) || a.startsWith('--in-place'))
      const nonflag: string[] = []
      let script: string | null = null
      for (let j = 0; j < args.length; j++) {
        const a = args[j]!
        if (a === '-e' || a === '--expression') {
          script = args[++j] ?? ''
          continue
        }
        if (a.startsWith('-')) continue
        nonflag.push(a)
      }
      if (script === null) script = nonflag.shift() ?? ''
      for (const f of nonflag.flatMap(expandVar)) {
        const r = addPath(f, !inPlace)
        if (inPlace && r) mutations.push({ kind: 'sed-i', target: r, sed: sedScript(script) })
      }
      continue
    }
    if (COPIERS.has(head)) {
      const nf = args.filter(a => !a.startsWith('-')).flatMap(expandVar)
      if (nf.length >= 2) {
        const dst = nf[nf.length - 1]!
        const dstR = ctx.rel(dst, false)
        for (const s of nf.slice(0, -1)) {
          const sR = ctx.rel(s)
          cps.push({ src: sR ?? s, dst: dstR ?? dst, dstProject: !!dstR })
          if (sR) info.paths.push(sR)
          if (head === 'mv' && sR) mutations.push({ kind: 'mv', target: sR })
        }
        if (dstR && dstR !== '.') {
          mutations.push({ kind: head, target: dstR })
          info.paths.push(dstR)
        }
      }
      continue
    }
    if (FS_WRITERS.has(head)) {
      for (const a of args.filter(a => !a.startsWith('-')).flatMap(expandVar)) {
        const r = ctx.rel(a, head !== 'mkdir')
        if (r && r !== '.') mutations.push({ kind: head, target: r })
      }
      continue
    }
    if (head === 'tee') {
      for (const a of args.filter(a => !a.startsWith('-'))) {
        const r = ctx.rel(a, false)
        if (r) mutations.push({ kind: 'tee', target: r })
      }
      continue
    }
    if (READERS.has(head)) {
      for (const a of args.filter(a => !a.startsWith('-')).flatMap(expandVar)) addPath(a, true)
      continue
    }
    if (GREPS.has(head)) {
      const nf: string[] = []
      for (let j = 0; j < args.length; j++) {
        const a = args[j]!
        if (a === '-e' || a === '--regexp') {
          info.patterns.push(args[++j] ?? '')
          continue
        }
        if (GREP_VALUE_FLAG_RE.test(a)) {
          j++
          continue
        }
        if (a.startsWith('-')) continue
        nf.push(a)
      }
      if (nf.length && !info.patterns.length) info.patterns.push(nf.shift()!)
      for (const a of nf.flatMap(expandVar)) addPath(a)
      continue
    }
    // anything else (ls, wc, find, echo, diff, which, …): note the paths
    for (const a of args.flatMap(expandVar)) addPath(a)
  }

  // Net-zero edits inside one command: stash/pop, cp X backup … cp backup X, a sed -i and its inverse.
  let removed = false
  const stashPush = mutations.filter(m => m.kind === 'stash-push')
  const stashPop = mutations.filter(m => m.kind === 'stash-pop')
  if (stashPush.length && stashPop.length) {
    for (const m of [...stashPush, ...stashPop]) mutations.splice(mutations.indexOf(m), 1)
    removed = true
  }
  for (const c of cps.filter(c => c.dstProject)) {
    // the restore of a backup taken earlier in the same command
    if (cps.some(o => o !== c && o.src === c.dst && o.dst === c.src && !o.dstProject)) {
      const i = mutations.findIndex(m => (m.kind === 'cp' || m.kind === 'mv') && m.target === c.dst)
      if (i >= 0) {
        mutations.splice(i, 1)
        removed = true
      }
      // and the sed -i it protected
      for (let k = mutations.length - 1; k >= 0; k--) if (mutations[k]!.kind === 'sed-i' && mutations[k]!.target === c.dst) mutations.splice(k, 1)
    }
  }
  const seds = mutations.filter(m => m.kind === 'sed-i')
  for (let a = 0; a < seds.length; a++)
    for (let b = a + 1; b < seds.length; b++) {
      const x = seds[a]!
      const y = seds[b]!
      if (x.target !== y.target || !x.sed || !y.sed) continue
      const inverse = (y.sed.a.includes(x.sed.b) || x.sed.b.includes(y.sed.a)) && (y.sed.b.includes(x.sed.a) || x.sed.a.includes(y.sed.b))
      if (inverse && mutations.includes(x) && mutations.includes(y)) {
        mutations.splice(mutations.indexOf(x), 1)
        mutations.splice(mutations.indexOf(y), 1)
        removed = true
      }
    }
  info.revertCheck = removed && info.verifies
  info.mutates = mutations.length > 0
  info.editTargets = [...new Set(mutations.map(m => m.target).filter((t): t is string => !!t))]
  info.created = info.editTargets.filter(t => !universe.has(t))
  info.paths = [...new Set(info.paths)]
  info.readTargets = [...new Set(info.readTargets)]
  return info
}

// --- Tools ------------------------------------------------------------------

const META_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop'])
const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const PATCH_TOOLS = new Set(['Patch', 'apply_patch'])
const CHECK_TOOLS = new Set(['RunTests', 'Typecheck', 'Build'])
const PATCH_PATH_RE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\s*$/gm
const NEWLINE_RUN_RE = /\s*\n\s*/g
const GIT_PREFIX_RE = /^git\s+/
const WHITESPACE_RE = /\s+/
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(NEWLINE_RUN_RE, '⏎ ')

function toolInfo(t: ToolUse, ws: string, universe: Set<string>, lastPatch: { targets: string[] }): ToolInfo {
  const ctx = new Ctx(ws)
  const base: ToolInfo = {
    name: t.name,
    kind: 'ORIENT',
    meta: false,
    commits: false,
    verifies: false,
    mutates: false,
    computes: false,
    testRun: false,
    revertCheck: false,
    editTargets: [],
    created: [],
    readTargets: [],
    paths: [],
    patterns: [],
    isResubmit: false,
    summary: t.name,
    heads: [],
    gitSubs: [],
  }
  const inp = t.input
  if (META_TOOLS.has(t.name)) {
    base.meta = true
    base.summary = `${t.name}(${clip(JSON.stringify(inp), 60)})`
  } else if (t.name === 'Bash') {
    const cmd = String(inp.command ?? '')
    const b = analyzeBash(cmd, ws, universe)
    Object.assign(base, b)
    base.parserMutates = b.mutates
    const st = t.structured
    const diff = isRec(st) && isRec(st.bashEditDiff) ? st.bashEditDiff.files : undefined
    if (Array.isArray(diff)) {
      const files = diff.map(f => ctx.rel(String((isRec(f) ? f.filePath : undefined) ?? ''), false)).filter((p): p is string => !!p)
      base.diffFiles = files
      if (files.length) {
        base.mutates = true
        base.editTargets = [...new Set(files)]
        base.created = base.editTargets.filter(f => !universe.has(f))
        base.revertCheck = false
      }
    }
    base.summary = `Bash(${clip(oneLine(cmd), 80)})`
  } else if (t.name === 'Read') {
    const ps = (Array.isArray(inp.file_paths) ? list(inp.file_paths) : [inp.file_path]).filter((p): p is string => typeof p === 'string' && !!p)
    const rels = ps.map(p => ctx.rel(p, false)).filter((p): p is string => !!p)
    base.readTargets = rels
    base.paths = rels
    const range = inp.offset || inp.limit ? `:${String(inp.offset ?? 1)}+${String(inp.limit ?? '')}` : ''
    base.summary = rels.length > 1 ? `Read[${rels.length}: ${clip(rels.join(' '), 70)}]` : `Read(${rels[0] ?? '?'}${range})`
  } else if (t.name === 'Grep') {
    base.patterns = [String(inp.pattern ?? '')]
    const p = inp.path ? ctx.rel(String(inp.path), false) : null
    if (p) base.paths = [p]
    base.summary = `Grep(${clip(String(inp.pattern ?? ''), 30)} ${p ?? ''})`
  } else if (t.name === 'Glob') {
    const p = inp.path ? ctx.rel(String(inp.path), false) : null
    if (p) base.paths = [p]
    base.summary = `Glob(${String(inp.pattern)} ${p ?? ''})`
  } else if (FILE_EDIT_TOOLS.has(t.name)) {
    const p = ctx.rel(String(inp.file_path ?? inp.notebook_path ?? ''), false)
    base.mutates = true
    if (p) {
      base.editTargets = [p]
      base.paths = [p]
      if (t.name === 'Write' && !universe.has(p)) base.created = [p]
    }
    base.summary = `${t.name}(${p ?? '?'})`
  } else if (PATCH_TOOLS.has(t.name)) {
    const text = String(inp.patchText ?? inp.input ?? '')
    base.mutates = true
    if (text.trim() === '*** Resubmit') {
      base.isResubmit = true
      base.editTargets = [...lastPatch.targets]
      base.summary = `Patch(*** Resubmit)`
    } else {
      const heads = [...text.matchAll(PATCH_PATH_RE)]
      const targets = heads.map(m => ctx.rel(m[2]!, false)).filter((p): p is string => !!p)
      base.editTargets = [...new Set(targets)]
      base.created = heads
        .filter(m => m[1] === 'Add File' || m[1] === 'Move to')
        .map(m => ctx.rel(m[2]!, false))
        .filter((p): p is string => !!p)
      lastPatch.targets = base.editTargets
      base.summary = `Patch[${clip(base.editTargets.map(p => (base.created.includes(p) ? '+' : '') + p).join(' '), 90)}]`
    }
    base.paths = [...base.editTargets]
  } else if (t.name === 'Git') {
    const cmds = Array.isArray(inp.commands) ? list(inp.commands).map(String) : [String(inp.command ?? '')]
    for (const c of cmds) {
      const b = analyzeBash(c, ws, universe)
      base.commits ||= b.commits
      base.mutates ||= b.mutates
      base.editTargets.push(...b.editTargets)
      base.paths.push(...b.paths)
      base.heads.push(...b.heads)
      base.gitSubs.push(...b.gitSubs)
    }
    base.summary = `Git[${clip(cmds.map(c => c.replace(GIT_PREFIX_RE, '').split(WHITESPACE_RE).slice(0, 2).join(' ')).join('; '), 70)}]`
  } else if (CHECK_TOOLS.has(t.name)) {
    base.verifies = true
    base.testRun = t.name === 'RunTests'
    base.summary = `${t.name}(${clip(JSON.stringify(inp), 50)})`
  } else {
    base.summary = `${t.name}(${clip(JSON.stringify(inp), 50)})`
  }
  base.kind = base.meta ? 'META' : base.commits ? 'COMMIT' : base.verifies && !base.mutates ? 'VERIFY' : base.mutates ? 'EDIT' : 'ORIENT'
  return base
}

// --- Errors -----------------------------------------------------------------

const TEST_FAIL_RE = /^\s*[1-9]\d* fail\s*$|^\(fail\) |Unhandled error between tests|^error: expect\(received\)/m
const READ_GATE_RE = /has not been read|modified since|only read in part|was modified|Read it first/i
const NOT_FOUND_RE = /String to replace not found|Failed to find expected lines|could not stage|not found in (?:the )?file|No match/i
const PATCH_FORMAT_RE = /appears in more than one section|Invalid patch|malformed/i
const DENIAL_RE = /Permission .*denied|has been denied|classifier|requires approval|not permitted/i
const REDIRECT_RE = /Use the \w+ tool|instead of Bash|redirected to|^(?:<tool_use_error>)?Blocked:/im
const EXIT_CODE_RE = /^Exit code \d+/
const TRUNCATED_RE = /characters truncated/
const TSC_MISSING_RE = /No version is set for shim: tsc|tsc: command not found|could not determine executable/i
const TESTS_PASS_RE = /^\s*0 fail\s*$/m
const CAT_ORDER = ['read-gate', 'string-not-found', 'patch-format', 'denial', 'redirect', 'test-failure', 'bash-exit+truncated', 'bash-exit(tsc missing)', 'bash-exit(tests pass)', 'bash-exit(other)', 'other']

function testFailed(t: ToolUse, info: ToolInfo): boolean {
  if (info.revertCheck) return false
  return TEST_FAIL_RE.test(t.result)
}

function errorCategory(t: ToolUse): string {
  const x = t.result
  if (READ_GATE_RE.test(x)) return 'read-gate'
  if (NOT_FOUND_RE.test(x)) return 'string-not-found'
  if (PATCH_FORMAT_RE.test(x)) return 'patch-format'
  if (DENIAL_RE.test(x)) return 'denial'
  if (REDIRECT_RE.test(x)) return 'redirect'
  if (TEST_FAIL_RE.test(x)) return 'test-failure'
  if (EXIT_CODE_RE.test(x)) {
    if (TRUNCATED_RE.test(x)) return 'bash-exit+truncated'
    if (TSC_MISSING_RE.test(x)) return 'bash-exit(tsc missing)'
    if (TESTS_PASS_RE.test(x)) return 'bash-exit(tests pass)'
    return 'bash-exit(other)'
  }
  return 'other'
}

// --- What the model knew before a request (M-batch, M-edit) -----------------

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g
const PATTERN_ALT_RE = /\\\||\|/
const CLASS_ESCAPE_RE = /\\[bBwWsSdD]/g
const BRACKET_RE = /\[[^\]]*\]/g
const ESCAPED_CHAR_RE = /\\(.)/g
const QUANTIFIER_RE = /[\^$*+?{}]|\.\*/g

const escapeRe = (s: string): string => s.replace(ESCAPE_RE, '\\$&')

function knownPath(p: string, corpus: string): boolean {
  if (isGlob(p)) {
    // A glob is known when the directory it expands in was: `src/*.ts` needs `src/`.
    const lit = p.slice(0, p.search(GLOB_CHAR_RE))
    const dir = lit.includes('/') ? lit.slice(0, lit.lastIndexOf('/')) : ''
    return !dir || corpus.includes(dir + '/') || new RegExp(`(^|[^\\w.\\-])${escapeRe(dir)}($|[^\\w\\-])`, 'm').test(corpus)
  }
  const re = new RegExp(`(^|[^\\w.\\-/])${escapeRe(p)}($|[^\\w\\-])`, 'm')
  if (re.test(corpus)) return true
  const b = basename(p)
  const d = dirname(p)
  const bre = new RegExp(`(^|[^\\w.\\-])${escapeRe(b)}($|[^\\w\\-])`, 'm')
  return bre.test(corpus) && (d === '.' || corpus.includes(d))
}

function knownPattern(pat: string, corpus: string): boolean {
  for (const alt of pat.split(PATTERN_ALT_RE)) {
    const lit = alt.replace(CLASS_ESCAPE_RE, ' ').replace(BRACKET_RE, ' ').replace(ESCAPED_CHAR_RE, '$1').replace(QUANTIFIER_RE, ' ').trim()
    const parts = lit.split(WHITESPACE_RE).filter(s => s.length >= 3)
    for (const part of parts) if (!corpus.includes(part) && !corpus.toLowerCase().includes(part.toLowerCase())) return false
  }
  return true
}

// --- Session ----------------------------------------------------------------

const RETRY_HEAD_RE = /^(bun (test|run|x)|tsc|bunx|npx|git (add|commit|stash|checkout))$/
const TSC_RETRY_HEAD_RE = /^(tsc|bunx|npx|bun x)$/
const CUT_OUTPUT_RE = /bash-output-filtered|characters truncated/
const NOW_READ_RE = /now count as read/
const FILTERED_RE = /<bash-output-filtered/

/**
 * Every request of a session with its label, levers and notes. `fixtureDir`
 * is the pristine project as a `.tpl` tree — the session-cache A/B's own by
 * default — which decides what a write created and what a cut output still
 * showed whole.
 */
export function classifySession(s: Session, fixtureDir = SESSION_CACHE_PROJECT): CallInfo[] {
  const universe = new Set(pristineFiles(fixtureDir))
  const lastPatch = { targets: [] as string[] }
  const out: CallInfo[] = []
  for (const call of s.calls) {
    const tools = call.tools.map(t => toolInfo(t, s.ws, universe, lastPatch))
    // Edit pairs that undo each other inside one request: a revert check through the Edit tool.
    const edits = call.tools.map((t, i) => ({ t, i })).filter(x => x.t.name === 'Edit')
    let revert = tools.some(t => t.revertCheck)
    for (const a of edits)
      for (const b of edits) {
        if (b.i <= a.i || a.t.input.file_path !== b.t.input.file_path) continue
        const ao = String(a.t.input.old_string ?? '')
        const an = String(a.t.input.new_string ?? '')
        const bo = String(b.t.input.old_string ?? '')
        const bn = String(b.t.input.new_string ?? '')
        if (bn.includes(ao) && bo.includes(an) && tools.some(x => x.verifies)) {
          tools[a.i]!.mutates = false
          tools[b.i]!.mutates = false
          tools[a.i]!.revertCheck = tools[b.i]!.revertCheck = true
          tools[a.i]!.kind = tools[b.i]!.kind = 'ORIENT'
          revert = true
        }
      }
    for (const t of tools) for (const c of t.created) universe.add(c)
    for (const t of tools) for (const c of t.editTargets) universe.add(c)
    const mutates = tools.some(t => t.mutates)
    const verifies = tools.some(t => t.verifies)
    const commits = tools.some(t => t.commits)
    const hardErr = call.tools.some(t => t.isError)
    // A revert check prints "(fail)" on purpose: that is not a failure.
    const softFail = !hardErr && !revert && call.tools.some((t, i) => testFailed(t, tools[i]!))
    let base: Label
    if (!tools.length) base = 'FINAL'
    else if (tools.every(t => t.meta)) base = 'META'
    else if (commits) base = 'COMMIT'
    else if (verifies && !mutates) base = 'VERIFY'
    else if (mutates) base = 'EDIT'
    else base = 'ORIENT'
    out.push({ call, tools, mutates, verifies, commits, revertCheck: revert, hardErr, softFail, base, label: base, reactCat: null, softReact: false, levers: [], notes: [] })
  }

  // REACT
  for (let i = 1; i < out.length; i++) {
    const cur = out[i]!
    const prev = out[i - 1]!
    if (cur.base === 'FINAL' || cur.base === 'META') continue
    const touch = cur.tools.flatMap(t => [...t.editTargets, ...t.readTargets, ...t.paths])
    // Files edited earlier in this phase: after a failing test, looking at one of them is a reaction.
    const editedInPhase: string[] = []
    for (let m = 0; m < i; m++) if (out[m]!.call.phase === cur.call.phase) editedInPhase.push(...out[m]!.tools.flatMap(t => t.editTargets))
    const related = (ptools: ToolInfo[], puses: ToolUse[], onlyErr: boolean) => {
      const cats: string[] = []
      puses.forEach((u, j) => {
        const e = ptools[j]!
        if (onlyErr && !u.isError) return
        if (!onlyErr && !testFailed(u, e)) return
        const eTargets = [...e.editTargets, ...e.readTargets, ...e.paths]
        const mentioned = [...universe].filter(f => u.result.includes(f))
        const failedTest = testFailed(u, e)
        const cat = onlyErr ? errorCategory(u) : 'test-failure(soft)'
        // A benign exit (tests passed, only a missing tsc or a trailing grep failed) is a reaction only if tsc is retried.
        if (cat === 'bash-exit(tsc missing)' || cat === 'bash-exit(tests pass)') {
          if (cur.tools.some(t => (t.name === 'Bash' || t.name === 'Git') && t.heads.some(h => TSC_RETRY_HEAD_RE.test(h)))) cats.push(cat)
          return
        }
        let hit = false
        for (const t of cur.tools) {
          if (t.name === e.name) {
            if (PATCH_TOOLS.has(t.name) && (t.isResubmit || overlap(t.editTargets, e.editTargets, universe))) hit = true
            if ((t.name === 'Edit' || t.name === 'Write' || t.name === 'Read') && overlap(t.paths, e.paths, universe)) hit = true
            // The same command again — a test run, a type check, a git subcommand — not two python edit scripts.
            if ((t.name === 'Bash' || t.name === 'Git') && (t.heads.some(h => RETRY_HEAD_RE.test(h) && e.heads.includes(h)) || overlap(t.paths, e.paths, universe))) hit = true
          }
        }
        if (overlap(touch, [...eTargets, ...mentioned], universe)) hit = true
        if (failedTest && (cur.mutates || cur.verifies || overlap(touch, editedInPhase, universe))) hit = true
        if (hit) cats.push(cat)
      })
      return cats
    }
    if (prev.hardErr) {
      const cats = related(prev.tools, prev.call.tools, true)
      if (cats.length) {
        cur.label = 'REACT'
        cur.reactCat = cats.sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b))[0]!
      }
    } else if (prev.softFail) {
      const cats = related(prev.tools, prev.call.tools, false)
      if (cats.length) cur.softReact = true
    }
  }

  // What the model had seen, per request: its prompts and attachments, and every earlier request with its results.
  const ws = s.ws
  const norm = (x: string) => x.split(ws + '/').join('').split(ws).join('.')
  const promptAt: { entry: number; text: string }[] = []
  s.entries.forEach((e, idx) => {
    const msg = e.message
    if (e.type === 'user' && !e.isSidechain && isRec(msg) && typeof msg.content === 'string') promptAt.push({ entry: idx, text: msg.content })
    const att = e.attachment
    if (e.type === 'attachment' && isRec(att) && typeof att.content === 'string') promptAt.push({ entry: idx, text: att.content })
  })
  /** What was visible when request j was written, plus request j's own inputs and texts. */
  const corpusThrough = (j: number): string => {
    const c = out[j]!.call
    const parts: string[] = promptAt.filter(p => p.entry < c.entryIndex).map(p => p.text)
    for (let m = 0; m <= j; m++) {
      const cm = out[m]!.call
      parts.push(...cm.texts, ...cm.tools.map(t => JSON.stringify(t.input)))
      if (m < j) parts.push(...cm.tools.map(t => t.result))
    }
    return norm(parts.join('\n'))
  }
  /** Files whose content the model had seen or written before request j was written. */
  const knownContentBefore = (j: number): Set<string> => {
    const known = new Set<string>()
    for (let m = 0; m < j; m++) {
      const ci = out[m]!
      ci.call.tools.forEach((u, q) => {
        const t = ci.tools[q]!
        const cut = CUT_OUTPUT_RE.test(u.result)
        if (!u.isError || NOW_READ_RE.test(u.result)) {
          for (const p of t.editTargets) known.add(p)
        }
        const files = t.readTargets.flatMap(p => (isGlob(p) ? [...universe].filter(f => globRe(p).test(f)) : [p]))
        for (const f of files) {
          // A cut Bash output still showed a pristine file when its head and tail are both in it.
          if (!cut || t.name === 'Read' || shownWhole(fixtureDir, f, u.result)) known.add(f)
        }
      })
    }
    return known
  }

  // Pattern tags, independent of the levers: compute requests, and re-reads of
  // what a Bash read in the request before did not show (filtered, or cut on error).
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!
    if (cur.tools.some(t => t.computes) && !cur.mutates && !cur.verifies) cur.notes.push('compute')
    if (i === 0) continue
    const prev = out[i - 1]!
    const lost = (re: RegExp) => prev.call.tools.flatMap((u, q) => (u.name === 'Bash' && re.test(u.result) ? prev.tools[q]!.readTargets : []))
    const reads = cur.tools.flatMap(t => [...t.readTargets, ...(t.name === 'Bash' ? t.paths : [])])
    const filtered = lost(FILTERED_RE)
    const truncated = lost(TRUNCATED_RE)
    if (filtered.length && overlap(reads, filtered, universe)) cur.notes.push('refetch-after-filter')
    if (truncated.length && overlap(reads, truncated, universe)) cur.notes.push('refetch-after-truncation')
  }

  // Levers
  for (let i = 1; i < out.length; i++) {
    const cur = out[i]!
    const prev = out[i - 1]!
    const prevClean = !prev.hardErr && !prev.softFail
    if (cur.label === 'REACT' || cur.base === 'FINAL') continue
    // Nothing merges into the previous phase's closing summary: the next prompt came in between.
    if (prev.base === 'FINAL' || prev.call.phase !== cur.call.phase) continue
    if (cur.softReact) {
      cur.notes.push('soft-react')
      continue
    }
    // M-toolsearch
    if (prev.tools.length && prev.tools.every(t => t.name === 'ToolSearch')) {
      const loaded = prev.call.tools.map(t => t.result).join('\n')
      if (cur.tools.some(t => loaded.includes(`"name": "${t.name}"`) || loaded.includes(`"name":"${t.name}"`) || loaded.includes(t.name))) cur.levers.push('M-toolsearch')
      continue
    }
    // M-chain
    if ((cur.label === 'VERIFY' || cur.label === 'COMMIT') && prevClean) {
      if (prev.base === 'EDIT' || prev.base === 'VERIFY' || (prev.label === 'REACT' && (prev.mutates || prev.verifies))) cur.levers.push('M-chain')
      else if (prev.base === 'COMMIT' && (prev.mutates || prev.verifies)) cur.levers.push('M-chain+stage')
    }
    // M-batch
    if (cur.label === 'ORIENT') {
      const corpus = corpusThrough(i - 1)
      const ps = cur.tools.flatMap(t => t.paths)
      const pats = cur.tools.flatMap(t => t.patterns)
      const unknownP = ps.filter(p => !knownPath(p, corpus))
      const unknownPat = pats.filter(p => !knownPattern(p, corpus))
      if (!unknownP.length && !unknownPat.length) cur.levers.push('M-batch')
      else cur.notes.push(`needs:${[...unknownP, ...unknownPat].slice(0, 3).join(',')}`)
    }
    // M-edit
    if (cur.label === 'EDIT' && prevClean && (prev.base === 'EDIT' || (prev.label === 'REACT' && prev.mutates))) {
      const known = knownContentBefore(i - 1)
      const created = new Set(cur.tools.flatMap(t => t.created))
      const targets = cur.tools.flatMap(t => t.editTargets).filter(p => !created.has(p))
      const missing = targets.filter(p => !known.has(p))
      if (!missing.length) cur.levers.push('M-edit')
      else cur.notes.push(`unread:${missing.slice(0, 3).join(',')}`)
    }
    // Not a lever of the census: a VERIFY right after an ORIENT whose inputs were known.
    if (cur.label === 'VERIFY' && prevClean && prev.label === 'ORIENT') {
      const corpus = corpusThrough(i - 1)
      const ps = cur.tools.flatMap(t => t.paths)
      if (ps.every(p => knownPath(p, corpus))) cur.levers.push('X-verify-after-orient')
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Mechanism metrics: what the request-count levers change inside one response
// ---------------------------------------------------------------------------

export const MECHANISM_METRICS = [
  'chainResponses',
  'gitReadWithCheck',
  'multiKindPatch',
  'multiKindPatchDoc',
  'skipped',
  'commitAfterFailure',
  'gitOnlyCalls',
  'globReads',
  'globReadFiles',
  // Round 4 (CLAUDIN_EDIT_THEN, CLAUDIN_GREP_BODIES): edits carrying `then`,
  // those whose check came back red, those whose `then` was dropped, and
  // symbols Greps asking for bodies.
  'thenEdits',
  'thenFailed',
  'thenDropped',
  'bodiesGreps',
] as const
export type Mechanism = Record<(typeof MECHANISM_METRICS)[number], number>
const zeroMechanism = (): Mechanism => ({
  chainResponses: 0,
  gitReadWithCheck: 0,
  multiKindPatch: 0,
  multiKindPatchDoc: 0,
  skipped: 0,
  commitAfterFailure: 0,
  gitOnlyCalls: 0,
  globReads: 0,
  globReadFiles: 0,
  thenEdits: 0,
  thenFailed: 0,
  thenDropped: 0,
  bodiesGreps: 0,
})

const GIT_READ_SUBS = new Set(['status', 'diff', 'log', 'show'])
const SKIPPED_RE = /^<tool_use_error>Skipped:/
/** A call the harness refused before it ran: skipped, blocked, invalid input. */
const REFUSED_RE = /^<tool_use_error>/
/** The Bash filter's marker, disclosing the real status of a base whose `| tail` it stripped (`outputFilter/Bash/markers.ts`). */
const STRIPPED_EXIT_RE = /^<bash-output-(?:filtered|rewritten)\b[^>]*\sexit="[1-9]\d*"/
const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const SOURCE_PATH_RE = /\.[cm]?[jt]sx?$/
const DOC_PATH_RE = /\.(md|mdx|markdown|rst)$/i
/** The line a batch Read writes above each file it shows (FileReadTool/batchRead.ts). */
const BATCH_HEADER_RE = /^==> .+ <==$/gm
/** A `file_paths` entry the Read expands as a glob: an unescaped `*` `?` `[` `{` (FileReadTool/readGlobs.ts `isReadGlob`). */
const READ_GLOB_RE = /(?<!\\)(?:\\\\)*[*?[{]/
/** What an edit's result says when its `then` was dropped (tools/shared/editThen/editThen.ts `formatThen`). */
const THEN_DROPPED_RE = /`then` did not run:/
/** The Bash floor cap's marker for the middle it cut (outputFilter/Bash/pipeline.ts). */
const CAP_CUT_RE = /lines omitted…/

/** A Git or Bash call reading git state (status/diff/log/show) that writes and checks nothing. */
const readsGitState = (t: ToolInfo): boolean =>
  (t.name === 'Git' || t.name === 'Bash') && !t.mutates && !t.commits && !t.verifies && t.gitSubs.length > 0 && t.gitSubs.every(s => GIT_READ_SUBS.has(s))

const runsCommit = (t: ToolInfo): boolean => (t.name === 'Git' || t.name === 'Bash') && t.gitSubs.includes('commit')

/** Commands that only cut down the output piped into them. */
const OUTPUT_TRIMMERS = new Set(['head', 'tail'])

/** The Git tool, or a Bash call whose every command is git or a head/tail trimming the output piped into it. */
function isGitCall(u: ToolUse, t: ToolInfo): boolean {
  if (t.name === 'Git') return true
  if (t.name !== 'Bash') return false
  const segs = parseShell(String(u.input.command ?? ''))
  return (
    segs.length > 0 &&
    segs.every(seg => {
      const head = seg.words.find(w => !LEAD_KEYWORDS.has(w) && !ASSIGNMENT_RE.test(w))
      return head === 'git' || (head !== undefined && OUTPUT_TRIMMERS.has(head) && seg.opBefore === '|')
    })
  )
}

/** A Read input with a glob among its `file_paths`. */
const readsGlob = (input: Json): boolean => list(input.file_paths).some(p => typeof p === 'string' && READ_GLOB_RE.test(p))

/** Whether a commit call actually ran it: not refused by the harness, nor left behind a failed command of the same Git call. */
function commitRan(u: ToolUse): boolean {
  if (REFUSED_RE.test(u.result)) return false
  const notRun = isRec(u.structured) ? list(u.structured.notRun) : []
  return !notRun.some(c => typeof c === 'string' && analyzeBash(c, '', new Set()).gitSubs.includes('commit'))
}

/**
 * A failed call, by what the transcript shows: an error result; a nonzero
 * `exitCode` from RunTests/Typecheck/Build, which never set `is_error`; or,
 * unless the request is a revert check failing on purpose, a stripped
 * `| tail`'s real status on the filter marker, or failing tests in the output.
 */
function callFailed(u: ToolUse, t: ToolInfo, revertCheck: boolean): boolean {
  if (u.isError) return true
  const s = u.structured
  if (CHECK_TOOLS.has(u.name) && isRec(s) && typeof s.exitCode === 'number' && s.exitCode !== 0) return true
  // The request's flag already covers a Bash revert check: it starts as "any tool is one".
  if (revertCheck) return false
  return (u.name === 'Bash' && STRIPPED_EXIT_RE.test(u.result)) || testFailed(u, t)
}

/** The mechanism metrics of one request. */
function requestMechanism(ci: CallInfo): Mechanism {
  const m = zeroMechanism()
  const firstEdit = ci.tools.findIndex(t => t.kind === 'EDIT')
  if (firstEdit >= 0 && ci.tools.some((t, i) => i > firstEdit && t.kind === 'VERIFY')) m.chainResponses = 1
  if (ci.tools.some(t => t.kind === 'VERIFY') && ci.tools.some(readsGitState)) m.gitReadWithCheck = 1
  if (ci.tools.length > 0 && !ci.mutates && ci.call.tools.every((u, i) => isGitCall(u, ci.tools[i]!))) m.gitOnlyCalls = 1
  let failedBefore = false
  ci.call.tools.forEach((u, i) => {
    const t = ci.tools[i]!
    if (SKIPPED_RE.test(u.result)) m.skipped++
    if (u.name === 'Read' && readsGlob(u.input)) {
      m.globReads++
      m.globReadFiles += u.result.match(BATCH_HEADER_RE)?.length ?? 0
    }
    if ((PATCH_TOOLS.has(u.name) || FILE_EDIT_TOOLS.has(u.name)) && list(u.input.then).length > 0) {
      m.thenEdits++
      const runs = isRec(u.structured) ? list(u.structured.then) : []
      if (runs.some(r => isRec(r) && r.ran === true && r.exitCode !== 0)) m.thenFailed++
    }
    if (THEN_DROPPED_RE.test(u.result)) m.thenDropped++
    if (u.name === 'Grep' && u.input.bodies === true) m.bodiesGreps++
    if (PATCH_TOOLS.has(t.name) && !u.isError) {
      const files = t.editTargets
      if (files.some(f => TEST_PATH_RE.test(f)) && files.some(f => SOURCE_PATH_RE.test(f) && !TEST_PATH_RE.test(f))) {
        m.multiKindPatch++
        if (files.some(f => DOC_PATH_RE.test(f))) m.multiKindPatchDoc++
      }
    }
    if (failedBefore && runsCommit(t) && commitRan(u)) m.commitAfterFailure++
    if (callFailed(u, t, ci.revertCheck)) failedBefore = true
  })
  return m
}

/** The mechanism metrics of a session: each summed over its requests. */
export function mechanismOf(infos: CallInfo[]): Mechanism {
  const total = zeroMechanism()
  for (const ci of infos) {
    const m = requestMechanism(ci)
    for (const k of MECHANISM_METRICS) total[k] += m[k]
  }
  return total
}

/** The listing's tags for one request's mechanism metrics. */
function mechanismTags(ci: CallInfo): string[] {
  const m = requestMechanism(ci)
  return [
    m.chainResponses ? 'chain-resp' : '',
    m.gitReadWithCheck ? 'git-read+check' : '',
    m.multiKindPatchDoc ? 'patch:src+test+doc' : m.multiKindPatch ? 'patch:src+test' : '',
    m.commitAfterFailure ? 'commit-after-failure' : '',
    m.gitOnlyCalls ? 'git-only' : '',
    m.globReads ? `glob-read:${m.globReadFiles}` : '',
    m.thenEdits ? (m.thenFailed ? 'then:red' : 'then') : '',
    m.thenDropped ? 'then-dropped' : '',
    m.bodiesGreps ? 'grep-bodies' : '',
  ].filter(Boolean)
}

/**
 * Fixture sources the Bash cap hid from the session's first response and a
 * request 3-6 then read, where the request right after the first did not —
 * the late read a cut listing costs (CLAUDIN_CAP_KEEP_PATHS; team memory
 * `request-count-levers-2026-09-24`, round 3).
 */
function hiddenPathReads(infos: CallInfo[], fixtureDir: string): number {
  const first = infos[0]?.call.tools.find(u => u.name === 'Bash')
  if (!first || !CAP_CUT_RE.test(first.result)) return 0
  const hidden = new Set(pristineFiles(fixtureDir).filter(p => p.startsWith('src/') && !first.result.includes(p)))
  const second = new Set(infos[1]?.tools.flatMap(t => t.readTargets) ?? [])
  const late = new Set<string>()
  for (const ci of infos.slice(2, 6)) {
    for (const p of ci.tools.flatMap(t => t.readTargets)) if (hidden.has(p) && !second.has(p)) late.add(p)
  }
  return late.size
}

/** A request that only Reads, every file of it named in the Grep result of the request before: the read Grep bodies folds in. */
function readsGrepHits(prev: CallInfo, ci: CallInfo): boolean {
  const grepText = prev.call.tools.filter(u => u.name === 'Grep').map(u => u.result).join('\n')
  if (!grepText || !ci.tools.length || !ci.tools.every(t => t.name === 'Read')) return false
  const reads = ci.tools.flatMap(t => t.readTargets)
  return reads.length > 0 && reads.every(p => grepText.includes(p))
}

/** A phase's responses before its first edit, or all of them when it never edits. */
function responsesBeforeFirstEdit(infos: CallInfo[], phase: 1 | 2): number {
  const inPhase = infos.filter(ci => ci.call.phase === phase)
  const first = inPhase.findIndex(ci => ci.mutates)
  return first < 0 ? inPhase.length : first
}

// ---------------------------------------------------------------------------
// Per session and per arm
// ---------------------------------------------------------------------------

const LABELS = ['FINAL', 'META', 'REACT', 'COMMIT', 'VERIFY', 'EDIT', 'ORIENT'] as const
const LEVERS = ['M-chain', 'M-toolsearch', 'M-batch', 'M-edit'] as const
const EXTRA_LEVERS = ['M-chain+stage', 'X-verify-after-orient'] as const
const TAGS = ['compute', 'refetch-after-filter', 'refetch-after-truncation'] as const
const SUB_KINDS = [
  'batch:reads-before-first-edit',
  'batch:reads-after-edits',
  'batch:git-state',
  'batch:compute',
  'chain:verify-after-edit',
  'chain:verify-after-verify',
  'chain:commit',
  'edit:split-across-files',
  'edit:same-file-followup',
  'pattern:read-gate-resubmit',
  'pattern:patch-context-retry',
  'pattern:truncation-refetch',
  'pattern:filter-refetch',
  'pattern:tsc-probe',
  'pattern:separate-git-state-call',
  'pattern:compute-retry',
  'pattern:revert-check-redo',
  'pattern:grep-then-read',
]
const GIT_STATE_HEAD_RE = /^git (status|diff|log|show)$/
const TSC_PROBE_HEAD_RE = /^(tsc|which|bunx|npx|head|ls|echo)$/
const GIT_HEAD_RE = /^git /

/** One number per metric: the labels, levers, tags, lever sub-kinds and patterns, and the mechanism metrics. */
export type SessionRow = Record<string, number>

export type SessionResult = { infos: CallInfo[]; row: SessionRow; reactCats: Map<string, number> }

export function analyzeSession(s: Session, fixtureDir = SESSION_CACHE_PROJECT): SessionResult {
  const infos = classifySession(s, fixtureDir)
  const r: SessionRow = { total: infos.length, p1: 0, p2: 0, subagentCalls: s.subagentCalls }
  for (const l of [...LABELS, ...LEVERS, ...EXTRA_LEVERS, 'softReact', 'revertChecks', 'hardErrCalls', ...TAGS]) r[l] = 0
  const bump = (k: string) => (r[k] = (r[k] ?? 0) + 1)
  const reactCats = new Map<string, number>()
  for (const ci of infos) {
    bump(ci.label)
    bump(`p${ci.call.phase}`)
    for (const l of ci.levers) bump(l)
    for (const n of ci.notes) if ((TAGS as readonly string[]).includes(n)) bump(n)
    if (ci.softReact) bump('softReact')
    if (ci.revertCheck) bump('revertChecks')
    if (ci.hardErr) bump('hardErrCalls')
    if (ci.label === 'REACT') {
      const cat = ci.reactCat ?? 'other'
      reactCats.set(cat, (reactCats.get(cat) ?? 0) + 1)
    }
  }
  r.mergeable = LEVERS.reduce((a, l) => a + (r[l] ?? 0), 0)

  let editedInPhase = false
  infos.forEach((ci, i) => {
    const prev = infos[i - 1]
    if (prev && prev.call.phase !== ci.call.phase) editedInPhase = false
    if (ci.levers.includes('M-batch')) {
      const gitOnly = ci.tools.every(t => t.name === 'Git' || (t.name === 'Bash' && t.heads.length > 0 && t.heads.every(h => GIT_STATE_HEAD_RE.test(h))))
      if (gitOnly) bump('batch:git-state')
      else if (ci.notes.includes('compute')) bump('batch:compute')
      else if (!editedInPhase) bump('batch:reads-before-first-edit')
      else bump('batch:reads-after-edits')
    }
    if (prev && ci.levers.includes('M-chain')) {
      if (ci.label === 'COMMIT') bump('chain:commit')
      else if (prev.mutates) bump('chain:verify-after-edit')
      else bump('chain:verify-after-verify')
    }
    if (prev && ci.levers.includes('M-edit')) {
      const before = prev.tools.flatMap(t => t.editTargets)
      const same = ci.tools.flatMap(t => t.editTargets).some(p => before.includes(p))
      bump(same ? 'edit:same-file-followup' : 'edit:split-across-files')
    }
    if (ci.notes.includes('refetch-after-filter') && ci.call.k >= 3) bump('pattern:filter-refetch')
    if (ci.label === 'REACT' && ci.reactCat === 'bash-exit+truncated') bump('pattern:truncation-refetch')
    if (ci.label === 'REACT' && ci.reactCat === 'read-gate') bump('pattern:read-gate-resubmit')
    if (ci.label === 'REACT' && ci.reactCat === 'string-not-found') bump('pattern:patch-context-retry')
    // tsc probing: a VERIFY whose only check is tsc (or `which tsc`)
    if (
      ci.label === 'VERIFY' &&
      ci.tools.every(t => t.heads.length > 0 && t.heads.every(h => TSC_PROBE_HEAD_RE.test(h))) &&
      ci.tools.some(t => t.heads.includes('tsc'))
    )
      bump('pattern:tsc-probe')
    // The git state read in a request of its own, right before the commit.
    if (ci.label === 'COMMIT' && prev && prev.label === 'ORIENT' && prev.tools.every(t => t.name === 'Git' || t.heads.every(h => GIT_HEAD_RE.test(h))))
      bump('pattern:separate-git-state-call')
    if (ci.notes.includes('compute') && prev?.notes.includes('compute')) bump('pattern:compute-retry')
    if (ci.revertCheck && prev?.revertCheck) bump('pattern:revert-check-redo')
    if (prev && readsGrepHits(prev, ci)) bump('pattern:grep-then-read')
    if (ci.mutates) editedInPhase = true
  })
  r.resume = responsesBeforeFirstEdit(infos, 2)
  r.firstEditTurn = responsesBeforeFirstEdit(infos, 1)
  r.hiddenPathReads = hiddenPathReads(infos, fixtureDir)
  Object.assign(r, mechanismOf(infos))
  return { infos, row: r, reactCats }
}

export type ArmSummary = {
  arm: string
  /** One row per session, in rep order. */
  rows: SessionRow[]
  /** REACT requests by the error category of the request before, summed over sessions. */
  reactCats: Map<string, number>
}

export function summarizeArm(arm: string, sessions: SessionResult[]): ArmSummary {
  const reactCats = new Map<string, number>()
  for (const s of sessions) for (const [cat, n] of s.reactCats) reactCats.set(cat, (reactCats.get(cat) ?? 0) + n)
  return { arm, rows: sessions.map(s => s.row), reactCats }
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** `median [min–max]`, or the one value when every session agrees. */
function fmt(xs: number[]): string {
  if (!xs.length) return '-'
  const m = median(xs)
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return lo === hi ? `${m}` : `${m} [${lo}–${hi}]`
}

const REPORT_METRICS = ['total', 'p1', 'p2', ...LABELS, 'mergeable', ...LEVERS, ...EXTRA_LEVERS, 'softReact', 'revertChecks', 'hardErrCalls', ...TAGS, 'resume', 'subagentCalls']
/** The mechanism table: the per-request metrics summed per session, phase 1's responses before its first edit, and the late reads of a cut listing. */
const MECHANISM_ROWS = [...MECHANISM_METRICS, 'firstEditTurn', 'hiddenPathReads']

/** The per-arm report: every metric as median [min–max] over sessions, then sums, sub-kinds and REACT causes. */
export function renderReport(run: string, arms: ArmSummary[]): string {
  const colOf = (m: string) => (a: ArmSummary) => a.rows.map(r => r[m] ?? 0)
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0)
  const mean = (xs: number[]) => (xs.length ? (sum(xs) / xs.length).toFixed(1) : '-')
  const repCounts = new Set(arms.map(a => a.rows.length))
  const overReps = repCounts.size === 1 ? `${[...repCounts][0]} reps` : 'reps'
  const out: string[] = []
  out.push(`run ${run}: median [min–max] over reps`)
  out.push(['metric'.padEnd(22), ...arms.map(a => a.arm.padEnd(16))].join(' '))
  for (const m of REPORT_METRICS) out.push([m.padEnd(22), ...arms.map(a => fmt(colOf(m)(a)).padEnd(16))].join(' '))
  out.push('\nper-rep totals: ' + arms.map(a => `${a.arm}=${a.rows.map(r => r.total).join(',')}`).join('  '))
  out.push(`\nlever sub-kinds and patterns (sum over ${overReps} / median per session):`)
  out.push(['kind'.padEnd(34), ...arms.map(a => a.arm.padEnd(12))].join(' '))
  for (const k of SUB_KINDS) out.push([k.padEnd(34), ...arms.map(a => `${sum(colOf(k)(a))} / ${median(colOf(k)(a))}`.padEnd(12))].join(' '))
  out.push(`\nREACT by error category of k-1 (sum over ${overReps}):`)
  for (const a of arms) out.push(`  ${a.arm.padEnd(11)} ${[...a.reactCats].map(([c, n]) => `${c}=${n}`).join('  ') || '-'}`)
  out.push('\nper-rep label sums (sum over reps):')
  for (const a of arms) {
    out.push(`  ${a.arm.padEnd(11)} ${[...LABELS, ...LEVERS, ...EXTRA_LEVERS, 'softReact', ...TAGS].map(k => `${k}=${sum(colOf(k)(a))}`).join(' ')}`)
  }
  // The mean too: the request-count round's gates are pre-registered on means.
  out.push('\nmechanism per session: median [min–max] · sessions with at least one · mean')
  out.push(['metric'.padEnd(22), ...arms.map(a => a.arm.padEnd(24))].join(' '))
  const cell = (xs: number[]) => `${fmt(xs)} · ${xs.filter(x => x > 0).length}/${xs.length} · ${mean(xs)}`.padEnd(24)
  for (const m of MECHANISM_ROWS) out.push([m.padEnd(22), ...arms.map(a => cell(colOf(m)(a)))].join(' '))
  return out.join('\n')
}

const NEWLINES_RE = /\n/g

/**
 * One session request by request: label, the label before REACT, levers,
 * notes and mechanism tags — `first-edit` on each phase's first edit, where
 * firstEditTurn and resume stop counting — then the tools: `[ERR]` on a
 * failed one, `[SKIPPED]` on one the same-response guard refused.
 */
export function renderListing(title: string, infos: CallInfo[]): string {
  const lines = [`\n#### ${title} (${infos.length} calls)`]
  const status = (u: ToolUse) => (SKIPPED_RE.test(u.result) ? ' [SKIPPED]' : u.isError ? ' [ERR]' : '')
  const firstEdits = new Set(([1, 2] as const).map(phase => infos.find(ci => ci.call.phase === phase && ci.mutates)))
  for (const ci of infos) {
    const tools =
      ci.tools.map((t, i) => t.summary + status(ci.call.tools[i]!)).join(' + ') || (ci.call.texts[0] ?? '').slice(0, 60).replace(NEWLINES_RE, ' ')
    const tags = [
      ...ci.levers,
      ci.label === 'REACT' ? `<${ci.reactCat}>` : '',
      ci.softReact ? 'soft-react' : '',
      ci.revertCheck ? 'revert-check' : '',
      ci.softFail ? 'shows-fail' : '',
      ...ci.notes.filter(n => n !== 'soft-react'),
      ...mechanismTags(ci),
      firstEdits.has(ci) ? 'first-edit' : '',
    ].filter(Boolean)
    const base = ci.base !== ci.label ? `(${ci.base})`.padEnd(8) : ''.padEnd(8)
    lines.push(`${String(ci.call.k).padStart(2)} p${ci.call.phase} ${ci.label.padEnd(6)} ${base} ${tags.join(' ').padEnd(34)} ${tools}`)
  }
  return lines.join('\n')
}
