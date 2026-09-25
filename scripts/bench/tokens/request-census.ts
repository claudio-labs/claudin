#!/usr/bin/env bun
/**
 * Request census: how many of the API calls in recorded sessions could have
 * gone out in the response before them, and through which lever.
 *
 * One API call = one assistant response, grouped by `message.id` (a streamed
 * response lands as several transcript records that repeat the id). Each call
 * gets ONE primary label, first match wins:
 *
 *   FINAL     no tool call
 *   META      only ToolSearch / Task* / TodoWrite / plan mode / AskUserQuestion
 *   REACT     answers a tool of the call before it (k-1) that failed — is_error,
 *             a ✗/⚠ RunTests/Typecheck/Build, or failing test output — by
 *             touching the same target, taking the tool a refusal pointed to,
 *             or fixing/re-running after a failed check; the cause is bucketed
 *   COMMIT    git add / git commit
 *   VERIFY    a test / typecheck / build / lint, and nothing that writes
 *   EDIT      anything that writes (edit tools, shell writes, formatters, VCS
 *             writes)
 *   DELEGATE  Agent / Task / SendMessage
 *   ORIENT    the rest: reads, searches, listings
 *
 * and the lever flags saying it could have shared k-1's response. Every flag
 * is an UPPER BOUND and they overlap:
 *
 *   M-chain       VERIFY/COMMIT right after a clean EDIT/VERIFY. `:step` is the
 *                 mergeable one; `:rerun` re-runs the check k-1 just ran
 *   M-batch       ORIENT whose every target (path, pattern, URL) was already in
 *                 the conversation before k-1 finished. `:fresh` = named in what
 *                 the model had just seen and absent from k-1's results (the
 *                 "serial read of known targets" row); `:reread` = files read
 *                 already (`:paging` when read by k-1 or k-2); `:stale` and
 *                 `:vacuous` (no target at all) are the loose remainder
 *   M-edit        EDIT right after an edit-tools-only EDIT, on files whose
 *                 content was known before k-1
 *   M-task        a call made of Task* / TodoWrite only
 *   M-toolsearch  a ToolSearch-only call whose loaded tool the next call used
 *
 * The headline ceiling is the "core union": M-chain:step + M-toolsearch +
 * M-batch:fresh + M-edit + M-task. The report also splits the levers per model
 * family, since the prompt levers act per family.
 *
 * Corpus: `<config>/projects/<project>/` — every project dir except the ones
 * whose cwd was under /tmp (`-tmp`, `-tmp-*`: bench fixtures), or the ones
 * named by --projects.
 *   main threads   `<session>.jsonl`
 *   sub-agents     `<session>/subagents/agent-*.jsonl` (agentType from the
 *                  `.meta.json` beside it)
 *   compaction     `<session>/subagents/agent-acompact-*.jsonl` — counted, not
 *                  analysed
 * A file is in when its mtime is on or after local midnight of --since
 * (`find -newermt` semantics), so a session that started earlier but was
 * still active is counted whole.
 *
 * Dedupe: a fork and a compaction agent MIRROR their parent's history, so a
 * `message.id` belongs to the FIRST thread that holds it — main threads first,
 * then sub-agents, then compaction files, each by first timestamp. Only owned
 * calls are counted; mirrored ones stay in their thread, which keeps its k-1
 * chain intact. Without this the parent's calls are counted 2-6×.
 *
 * Baseline (2026-09-24, --since=2026-09-14, claudin + ferrous-dns, the
 * measuring session excluded): 94 sessions, 14,197 main + 11,720 sub-agent
 * calls; core union 19.8% main / 15.7% sub-agent; M-chain 10.6% main / 4.1%
 * sub-agent; M-chain:step is 4.0% of Opus 5.5's calls. That run came from a
 * scratchpad script; this is its port with every classification rule
 * unchanged — run side by side with it on the same transcripts, it wrote a
 * byte-identical calls.jsonl and samples.txt.
 *
 * Transcripts are DATA: the report holds aggregates and short call listings
 * (tool names, relative paths, command heads); samples.txt adds the first 150
 * chars of each error a sampled REACT answered. Nothing but --out is written.
 *
 * Outputs, in --out (default: a fresh dir under the OS temp dir, printed at
 * the end): report.md (also printed), calls.jsonl (one row per owned call —
 * labels, flags, tool briefs; the input for ad-hoc queries), samples.txt
 * (seeded random samples per lever, for eyeballing precision).
 *
 * Run:
 *   bun scripts/bench/tokens/request-census.ts --since=2026-09-14
 *   bun scripts/bench/tokens/request-census.ts --since=2026-09-14 \
 *     --projects=-home-me-projects-app --exclude-session=<id> --out=/tmp/census
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, isAbsolute, join, normalize, resolve } from 'path'
import { REPO_ROOT } from '../../repoRoot.js'
import { configDir, pad } from './transcriptCorpus.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

export type ThreadKind = 'main' | 'sub' | 'compact'

/** One transcript: a session's main thread, one of its sub-agents, or a compaction agent. */
export type ThreadFile = {
  path: string
  kind: ThreadKind
  session: string
  /** Project dir name — the cwd slug. */
  project: string
  /** `main`, the sub-agent's agentType, `compact`, or `unknown`. */
  agentType: string
  agentId: string
  /** First record timestamp: orders the dedupe claim. */
  firstTs: number
}

type Res = { text: string; isError: boolean; tur: unknown }
/** `rawInput` is the input as recorded; `input` its object view for field access. */
type Use = { name: string; rawInput: unknown; input: Json; res: Res | null }
type Label = 'FINAL' | 'META' | 'REACT' | 'COMMIT' | 'VERIFY' | 'EDIT' | 'DELEGATE' | 'ORIENT'

export type Call = {
  id: string
  t: Thread
  /** Position in its thread (mirrored calls included), so `t.calls[seq] === this`. */
  seq: number
  /** False for a call another thread claimed first (a mirrored one). */
  owned: boolean
  model: string
  uses: Use[]
  /** Human prompts seen before it in the thread. */
  turn: number
  /** k-1, or null when a prompt, interrupt or compaction broke the chain. */
  prev: Call | null
  posStart: number
  posAfterInputs: number
  resetPos: number
  promptStart: number
  promptEnd: number
  base: Label
  primary: Label
  reactCause: string | null
  flags: Set<string>
}

export type Thread = {
  f: ThreadFile
  cwd: string
  calls: Call[]
  humanPrompts: number
  turnsWithCalls: Set<number>
  /** Lower-cased text of the thread in order; freed once the thread is evaluated. */
  corpus: string
  firstKnown: Map<string, number>
  hasDeferredInfo: boolean
  firstRead: Map<string, number>
  readSeqs: Map<string, number[]>
}

type DeferredUse = { thread: Thread; call: Call; use: Use }

export type Census = {
  /** Files processed, by kind. */
  files: Record<ThreadKind, number>
  /** Main and sub-agent threads (compaction files yield none). */
  threads: Thread[]
  /** Owned calls of main threads, then of sub-agents. */
  main: Call[]
  sub: Call[]
  all: Call[]
  parseErrors: number
  syntheticSkipped: number
  /** Compaction-agent calls nobody else held. */
  compactionCalls: number
  deferredNoSearch: DeferredUse[]
}

type Ctx = {
  claimed: Set<string>
  parseErrors: number
  syntheticSkipped: number
  compactionCalls: number
  deferredNoSearch: DeferredUse[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir()
const REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g
const NON_ALNUM_RE = /[^a-zA-Z0-9]/g
/** The project slug of the home dir: the app turns every non-alphanumeric into `-`. */
const HOME_SLUG = HOME.replace(NON_ALNUM_RE, '-')
/** A project path under ~/projects, stripped from the error heads in samples.txt. */
const HOME_PROJECT_RE = new RegExp(`${HOME.replace(REGEX_SPECIALS_RE, '\\$&')}/projects/[\\w-]+/`, 'g')
/** Project dirs of a cwd under /tmp: bench fixtures, not real work. */
const TMP_PROJECT_RE = /^-tmp(?:-|$)/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KIND_RANK: Record<ThreadKind, number> = { main: 0, sub: 1, compact: 2 }

const USAGE =
  'usage: bun scripts/bench/tokens/request-census.ts --since=YYYY-MM-DD [--projects=<dir,...>] [--exclude-session=<id,...>] [--out=<dir>]'

// Text helpers
const WS_RUN_RE = /\s+/g
const WS_SPLIT_RE = /\s+/
const TRAILING_SLASHES_RE = /\/+$/
const REGEX_ESCAPE_CLASS_RE = /\\[bBsSwWdDnrtAzZ]/g
const CHAR_CLASS_RE = /\[[^\]]*\]/g
const QUANTIFIER_RE = /\{\d*,?\d*\}/g
const GROUP_PREFIX_RE = /\(\?[:=!<]+/g
const ESCAPED_CHAR_RE = /\\(.)/g
const FRAGMENT_SPLIT_RE = /[\s^$.|?*+()[\]{},]+/

// Shell analysis
const HEREDOC_RE = /<<-?\s*['"]?\w+/
const SINGLE_QUOTED_RE = /'[^']*'/g
const DOUBLE_QUOTED_RE = /"(?:[^"\\]|\\.)*"/g
const REDIRECT_RE = /(?:^|[^<>=-])(?:\d|&)?>>?\s*([^\s&|;<>()]+)/g
const DEV_SINK_RE = /^\/dev\/(?:null|stderr|stdout|tty)$/
const TEE_RE = /\btee\s+(?:-a\s+)?([^\s|;&]+)/g
const DEV_PREFIX_RE = /^\/dev\//
const SHELL_TOKEN_RE = /'[^']*'|"(?:[^"\\]|\\.)*"|\|\||&&|[|;&]|[^\s|;&<>()]+/g
const ENV_ASSIGN_RE = /^\w+=/
const GREP_COMMAND_RE = /^(?:grep|rg|egrep|fgrep|ag|ack)$/
const FD_REDIRECT_TOKEN_RE = /^\d*>&?\d*$/
const URL_SCHEME_RE = /:\/\//
const GLOB_CHAR_RE = /[*?]/
const FILE_TOKEN_RE = /^[\w.-]+\.[a-z][a-z0-9]{0,5}$/i
const VERSION_TOKEN_RE = /^\d+(?:\.\d+)+$/
const SHA_TOKEN_RE = /^[0-9a-f]{7,40}$/

const COMMIT_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:add|commit)\b/
const VERIFY_RE =
  /\b(?:bun\s+(?:test\b|run\s+(?:test|typecheck|build|smoke|lint|verify|check|pre-?pr)[\w:-]*)|tsc\b|cargo\s+(?:test|build|check|clippy|nextest)\b|cargo\s+fmt\b[^|;&]*--check|npm\s+(?:test\b|run\s+(?:test|build|lint|typecheck))|pytest\b|go\s+(?:test|build|vet)\b|make\s+(?:test|check|build)\b|eslint\b|biome\s+(?:check|lint)\b|bun\s+scripts\/verify\/)/
const VCS_WRITE_RE =
  /\bgit\s+(?:-C\s+\S+\s+)?(?:apply|checkout|restore|reset|clean|rm|mv|am|cherry-pick|revert|merge|rebase|pull|switch|stash(?!\s+(?:list|show)))\b/
const WRITE_VERB_RE =
  /(?:^|[;&|(\n]\s*|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*)(?:mv|cp|rm|mkdir|touch|chmod|ln|truncate|install|rsync|unzip|patch)\s/
const SED_I_RE = /\bsed\b[^|;&\n]*\s(?:-[a-zA-Z]*i[a-zA-Z]*\b|--in-place)/
const PERL_I_RE = /\bperl\b[^|;&\n]*\s-[a-zA-Z]*i/
const FORMAT_RE =
  /\bcargo\s+fmt\b(?![^|;&]*--check)|\bprettier\b[^|;&]*--write|\beslint\b[^|;&]*--fix|\bbiome\b[^|;&]*--(?:write|apply)|\bbun\s+run\s+(?:format|fix)\b|\b(?:bun|npm|pnpm|yarn)\s+(?:add|remove|install|i|uninstall)\b|\bcargo\s+(?:add|remove|update)\b/
/** Polling / interactive driving: each step depends on fresh state, so never batchable. */
const POLL_RE = /\bsleep\s+\d|\btmux\s+(?:send-keys|capture-pane)|\btail\s+-[a-zA-Z]*f|\bwatch\b|--watch\b/
const READ_COMMAND_RE = /^(?:cat|head|tail|sed|nl|bat|less)$/
const CD_PREFIX_RE = /^cd\s+\S+\s*&&\s*/
const ENV_PREFIX_RE = /^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)+/

// Results
const BASH_FAIL_RE = /\b\d+ fail(?:ed)?\b|error TS\d+|error\[E\d+\]|test result: FAILED|\bFAIL\b/
const ZERO_FAIL_RE = /\b0 fail\b/
const PATCH_FILE_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
const PATH_IN_TEXT_RE = /[\w.@~/-]*[\w-]+\.(?:tsx?|jsx?|mjs|cjs|rs|json|md|toml|ya?ml|sh|py|go|css|html)\b/g
const TEST_INFIX_RE = /\.(test|spec)\./
const EXTENSION_RE = /\.[^.]+$/
const REDIRECT_AVAILABLE_RE = /\band ([A-Za-z]+)(?:\/([A-Za-z]+))? (?:is|are) available/
const SUGGESTED_TOOL_RE = /\band ([A-Za-z]+(?:\/[A-Za-z]+)?) (?:is|are) available/
const READ_GATE_RE = /has not been read yet|modified since (?:it was )?read|was only read in part|Read it (?:first|again)/i
const EDIT_MISMATCH_RE =
  /String to replace not found|Failed to find expected lines|none of the \d+ line|Found \d+ matches of the string|No changes to make|appears in more than one section|apply_patch found \d+ problem/i
const PLAN_MODE_RE = /Plan mode is active/
const BLOCKED_RE = /^(?:<tool_use_error>)?Blocked:/
const SLEEP_WORD_RE = /sleep/i
const AVAILABLE_RE = /is available|are available/
const DENIAL_RE = /Permission for this action has been denied|doesn't want to proceed|was rejected/i
const PATH_MISSING_RE = /does not exist|No such file or directory|Path does not exist|ENOENT/i
const INVALID_INPUT_RE = /InputValidationError|No such tool available|not found\. Available|Invalid|unexpected parameter|rejected this search/i
const EXIT_CODE_RE = /^Exit code \d+/
const PARTIAL_READ_RE = /only read in part/
const MODIFIED_SINCE_RE = /modified since/
const NEVER_READ_RE = /has not been read/
const META_USER_TAG_RE = /^<(?:local-command-(?:stdout|stderr|caveat)|system-reminder|bash-stdout|bash-stderr)>/
const TOOL_REFERENCE_RE = /\[tool_reference:([^\]]+)\]/g
const NAME_FIELD_RE = /"name":\s*"([^"]+)"/g
/** A line number k-1 printed (grep -n, Read's `N→`). */
const LINE_NUMBER_RE = /(?:^|[\s:])(\d{1,6})(?=[:→\t-])/gm
const ABS_PATH_RE = /\/[\w./@-]+/g
const DIGITS_RE = /\d+/g

// Model families
const CLAUDE_MODEL_RE = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/
const QWEN_RE = /qwen/i
const GLM_RE = /glm/i
const KIMI_RE = /kimi/i

// Tool sets
const META_TOOLS = new Set(['ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'])
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Patch', 'apply_patch'])
const VERIFY_TOOLS = new Set(['RunTests', 'Typecheck', 'Build'])
const DELEGATE_TOOLS = new Set(['Agent', 'Task', 'SendMessage'])
const NON_BATCHABLE = new Set(['WaitFor', 'Monitor', 'TaskOutput', 'TaskStop', 'Sleep', 'ScheduleWakeup', 'CronCreate', 'CronDelete'])
/** REACT causes the harness produced by refusing a call. */
const HARNESS_CAUSES = new Set(['Bash redirect refusal', 'read gate', 'plan-mode refusal', 'permission/classifier denial', 'Bash refusal (sleep/blocking)'])

// ---------------------------------------------------------------------------
// JSON access
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null
}

function msgOf(r: Json): Json {
  return isObj(r.message) ? r.message : {}
}

/** The record's `message.id` as a key, or '' when it has none. */
function messageId(r: Json): string {
  const id = msgOf(r).id
  return id ? String(id) : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** `v[0]` for whatever JSON value a model sent (a Git `commands` string included). */
function first(v: unknown): unknown {
  if (typeof v === 'string' || Array.isArray(v)) return v[0]
  if (isObj(v)) return v['0']
  return undefined
}

/** `[...v]` of an optional list, as the model sent it. */
function spread(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [...v]
  return []
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function firstTimestamp(path: string): number {
  const raw = readFileSync(path, 'utf8')
  let start = 0
  while (start < raw.length) {
    let end = raw.indexOf('\n', start)
    if (end < 0) end = raw.length
    const line = raw.slice(start, end)
    start = end + 1
    if (!line) continue
    try {
      const r: unknown = JSON.parse(line)
      if (isObj(r) && r.timestamp) return Date.parse(String(r.timestamp))
    } catch {
      // an unparseable line carries no timestamp
    }
  }
  return statSync(path).mtimeMs
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * The project dirs to walk: the named ones (a bare name resolves under `root`),
 * or every dir under `root` but the /tmp ones, sorted.
 */
export function resolveProjectDirs(root: string, names: readonly string[]): string[] {
  if (names.length > 0) {
    return names.map(n => {
      const dir = isAbsolute(n) ? n : join(root, n)
      if (!existsSync(dir)) throw new Error(`no such project dir: ${dir}`)
      return dir
    })
  }
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !TMP_PROJECT_RE.test(e.name))
    .map(e => join(root, e.name))
    .sort()
}

/** Every transcript under `dirs` modified at or after `sinceMs`, minus the excluded sessions. */
export function discover(dirs: readonly string[], sinceMs: number, exclude: ReadonlySet<string>): ThreadFile[] {
  const out: ThreadFile[] = []
  for (const dir of dirs) {
    const project = basename(dir)
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const session = e.name.slice(0, -6)
        if (exclude.has(session)) continue
        const path = join(dir, e.name)
        const mtime = mtimeOf(path)
        if (mtime === null || mtime < sinceMs) continue
        out.push({ path, kind: 'main', session, project, agentType: 'main', agentId: '', firstTs: firstTimestamp(path) })
      } else if (e.isDirectory() && !exclude.has(e.name)) {
        const sd = join(dir, e.name, 'subagents')
        if (!existsSync(sd)) continue
        for (const n of readdirSync(sd)) {
          if (!n.endsWith('.jsonl')) continue
          const path = join(sd, n)
          const mtime = mtimeOf(path)
          if (mtime === null || mtime < sinceMs) continue
          const compact = n.startsWith('agent-acompact')
          let agentType = compact ? 'compact' : 'unknown'
          const meta = path.slice(0, -6) + '.meta.json'
          if (!compact && existsSync(meta)) {
            try {
              const m: unknown = JSON.parse(readFileSync(meta, 'utf8'))
              if (isObj(m) && m.agentType != null) agentType = String(m.agentType)
            } catch {
              // unreadable meta: the agentType stays unknown
            }
          }
          out.push({
            path,
            kind: compact ? 'compact' : 'sub',
            session: e.name,
            project,
            agentType,
            agentId: n.slice(0, -6),
            firstTs: firstTimestamp(path),
          })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Tool-result / message content as text; a `tool_reference` renders as `[tool_reference:<name>]`. */
function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .map((p: unknown) => {
      if (!isObj(p)) return ''
      if (typeof p.text === 'string') return p.text
      if (p.type === 'tool_reference') return `[tool_reference:${p.tool_name}]`
      return ''
    })
    .join('')
}

function trunc(s: string, n: number): string {
  const one = s.replace(WS_RUN_RE, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

function normPath(p: unknown, cwd: string): string {
  if (!p || typeof p !== 'string') return ''
  let s = p.trim()
  if (s.startsWith('~/')) s = HOME + '/' + s.slice(2)
  s = isAbsolute(s) ? normalize(s) : resolve(cwd, s)
  return s.replace(TRAILING_SLASHES_RE, '') || '/'
}

function relPath(abs: string, cwd: string): string {
  if (abs.startsWith(cwd + '/')) return abs.slice(cwd.length + 1)
  return abs
}

/** Lower-cased forms a path may appear as in the conversation. */
function pathCandidates(abs: string, cwd: string): string[] {
  const out = new Set<string>([abs.toLowerCase()])
  if (abs.startsWith(cwd + '/')) out.add(abs.slice(cwd.length + 1).toLowerCase())
  return [...out].filter(x => x.length >= 3)
}

/** Literal fragments (>=3 chars) of a regex/glob pattern. */
function fragments(pat: unknown): string[] {
  if (!pat || typeof pat !== 'string') return []
  let s = pat.replace(REGEX_ESCAPE_CLASS_RE, ' ').replace(CHAR_CLASS_RE, ' ').replace(QUANTIFIER_RE, ' ')
  s = s.replace(GROUP_PREFIX_RE, ' ').replace(ESCAPED_CHAR_RE, '$1')
  return s
    .split(FRAGMENT_SPLIT_RE)
    .map(x => x.trim().toLowerCase())
    .filter(x => x.length >= 3)
}

// ---------------------------------------------------------------------------
// Bash / Git command analysis
// ---------------------------------------------------------------------------

function firstLineIfHeredoc(cmd: string): { head: string; heredoc: boolean } {
  const hd = cmd.search(HEREDOC_RE)
  if (hd < 0) return { head: cmd, heredoc: false }
  const nl = cmd.indexOf('\n', hd)
  return { head: nl >= 0 ? cmd.slice(0, nl) : cmd, heredoc: true }
}

function stripQuotes(s: string): string {
  return s.replace(SINGLE_QUOTED_RE, "''").replace(DOUBLE_QUOTED_RE, '""')
}

type CmdKind = { commit: boolean; verify: boolean; write: boolean }

function analyzeCommand(cmd: unknown): CmdKind {
  const { head, heredoc } = firstLineIfHeredoc(String(cmd ?? ''))
  const s = stripQuotes(head)
  const commit = COMMIT_RE.test(s)
  const verify = VERIFY_RE.test(s)
  // Output redirections and tee: capture to /tmp is scratch, anything else is a write.
  const redirTargets: string[] = []
  for (const m of s.matchAll(REDIRECT_RE)) {
    const t = m[1]
    if (!t || t.startsWith('&') || DEV_SINK_RE.test(t)) continue
    redirTargets.push(t)
  }
  for (const m of s.matchAll(TEE_RE)) {
    if (!DEV_PREFIX_RE.test(m[1])) redirTargets.push(m[1])
  }
  const nonTmpRedirect = redirTargets.some(t => !t.startsWith('/tmp/'))
  let write = nonTmpRedirect || (heredoc && redirTargets.length > 0)
  if (WRITE_VERB_RE.test(s) || SED_I_RE.test(s) || PERL_I_RE.test(s) || VCS_WRITE_RE.test(s) || FORMAT_RE.test(s)) {
    write = true
  }
  return { commit, verify, write }
}

type Targets = { paths: string[]; frags: string[] }

/** Paths / patterns a shell command names (heuristic tokenizer). */
function commandTargets(cmd: unknown, cwd: string): Targets {
  const { head } = firstLineIfHeredoc(String(cmd ?? ''))
  const toks = head.match(SHELL_TOKEN_RE) ?? []
  const paths: string[] = []
  const frags: string[] = []
  let grepMode = false
  let grepPatternTaken = false
  let cmdWord = true
  let expectArg = false
  for (const raw of toks) {
    if (raw === '|' || raw === '||' || raw === '&&' || raw === ';' || raw === '&') {
      grepMode = false
      cmdWord = true
      continue
    }
    const quoted = raw.startsWith("'") || raw.startsWith('"')
    const t = quoted ? raw.slice(1, -1) : raw
    if (!quoted && ENV_ASSIGN_RE.test(t) && cmdWord) continue // env assignment
    if (cmdWord && !quoted) {
      cmdWord = false
      if (GREP_COMMAND_RE.test(t)) {
        grepMode = true
        grepPatternTaken = false
      }
      if (t === 'cd') expectArg = true
      continue
    }
    if (!quoted && t.startsWith('-')) {
      if (grepMode && (t === '-e' || t === '--regexp')) grepPatternTaken = false
      continue
    }
    if (expectArg) {
      expectArg = false
      if (normPath(t, cwd) === cwd) continue
    }
    if (grepMode && !grepPatternTaken) {
      frags.push(...fragments(t))
      grepPatternTaken = true
      continue
    }
    if (DEV_PREFIX_RE.test(t) || FD_REDIRECT_TOKEN_RE.test(t) || t === '.' || t === './') continue
    if (URL_SCHEME_RE.test(t)) {
      frags.push(t.toLowerCase())
      continue
    }
    if (GLOB_CHAR_RE.test(t)) {
      frags.push(...fragments(t))
      continue
    }
    if (t.includes('/') || FILE_TOKEN_RE.test(t)) {
      if (VERSION_TOKEN_RE.test(t)) continue
      const abs = normPath(t, cwd)
      if (abs !== cwd) paths.push(abs)
      continue
    }
    if (SHA_TOKEN_RE.test(t)) frags.push(t.toLowerCase())
  }
  return { paths, frags }
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

function useKind(u: Use): CmdKind {
  if (EDIT_TOOLS.has(u.name)) return { commit: false, verify: false, write: true }
  if (VERIFY_TOOLS.has(u.name)) return { commit: false, verify: true, write: false }
  if (u.name === 'Bash') return analyzeCommand(u.input.command)
  if (u.name === 'Git') {
    const cmds: unknown[] = Array.isArray(u.input.commands) ? u.input.commands : []
    let commit = false
    let write = false
    for (const c of cmds) {
      if (COMMIT_RE.test(stripQuotes(String(c)))) commit = true
      if (VCS_WRITE_RE.test(stripQuotes(String(c)))) write = true
    }
    return { commit, verify: false, write }
  }
  return { commit: false, verify: false, write: false }
}

function isVerifyUse(u: Use): boolean {
  if (VERIFY_TOOLS.has(u.name)) return true
  if (u.name === 'Bash') return analyzeCommand(u.input.command).verify
  return false
}

/** is_error, OR a semantic failure the verify tools report without is_error. */
function failed(u: Use): boolean {
  const r = u.res
  if (!r) return false
  if (r.isError) return true
  const t = r.text.trimStart()
  if (u.name === 'RunTests' || u.name === 'Build') return t.startsWith('✗')
  if (u.name === 'Typecheck') return t.startsWith('✗') || t.startsWith('⚠')
  if (u.name === 'Bash' && analyzeCommand(u.input.command).verify) {
    const zeroFail = ZERO_FAIL_RE.test(t)
    return !zeroFail && BASH_FAIL_RE.test(t)
  }
  return false
}

function baseLabel(c: Call): Label {
  if (c.uses.length === 0) return 'FINAL'
  if (c.uses.every(u => META_TOOLS.has(u.name))) return 'META'
  const ks = c.uses.map(useKind)
  if (ks.some(k => k.commit)) return 'COMMIT'
  const anyWrite = ks.some(k => k.write)
  if (ks.some(k => k.verify) && !anyWrite) return 'VERIFY'
  if (anyWrite) return 'EDIT'
  if (c.uses.some(u => DELEGATE_TOOLS.has(u.name))) return 'DELEGATE'
  return 'ORIENT'
}

// ---------------------------------------------------------------------------
// Paths a tool use touches
// ---------------------------------------------------------------------------

function patchFiles(text: unknown, cwd: string): { update: string[]; add: string[] } {
  const update: string[] = []
  const add: string[] = []
  for (const m of String(text ?? '').matchAll(PATCH_FILE_RE)) {
    if (m[3]) add.push(normPath(m[3], cwd))
    else if (m[1] === 'Add') add.push(normPath(m[2], cwd))
    else update.push(normPath(m[2], cwd))
  }
  return { update, add }
}

/** Every path named in a use's input (for REACT relatedness). */
function inputPaths(u: Use, cwd: string): string[] {
  const i = u.input
  const out: string[] = []
  const add = (p: unknown): void => {
    if (typeof p === 'string' && p) out.push(normPath(p, cwd))
  }
  switch (u.name) {
    case 'Read':
      add(i.file_path)
      if (Array.isArray(i.file_paths)) for (const p of i.file_paths) add(p)
      break
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      add(i.file_path)
      break
    case 'NotebookEdit':
      add(i.notebook_path)
      break
    case 'apply_patch':
    case 'Patch': {
      const p = patchFiles(i.patchText ?? i.patch ?? i.input, cwd)
      out.push(...p.update, ...p.add)
      break
    }
    case 'Grep':
    case 'Glob':
    case 'RunTests':
    case 'Typecheck':
      add(i.path)
      break
    case 'LSP':
      add(i.filePath ?? i.file_path)
      break
    case 'Bash':
      out.push(...commandTargets(i.command, cwd).paths)
      break
    case 'Git':
      for (const c of Array.isArray(i.commands) ? i.commands : []) out.push(...commandTargets(c, cwd).paths)
      break
  }
  return out.filter(p => p && p !== cwd)
}

/** Targets for the M-batch "already seen" test; null = not batchable. */
function orientTargets(u: Use, cwd: string): Targets | null {
  const i = u.input
  if (NON_BATCHABLE.has(u.name) || u.name.startsWith('mcp__')) return null
  if (u.name === 'Bash' && POLL_RE.test(String(i.command ?? ''))) return null
  if (u.name === 'Git' && (Array.isArray(i.commands) ? i.commands : []).some((c: unknown) => POLL_RE.test(String(c)))) return null
  switch (u.name) {
    case 'Read': {
      const paths: string[] = []
      if (typeof i.file_path === 'string') paths.push(normPath(i.file_path, cwd))
      if (Array.isArray(i.file_paths)) for (const p of i.file_paths) paths.push(normPath(p, cwd))
      const sym = i.symbol
      const frags = typeof sym === 'string' ? fragments(sym) : Array.isArray(sym) ? sym.flatMap((s: unknown) => fragments(s)) : []
      return { paths, frags }
    }
    case 'Grep':
    case 'Glob': {
      const paths: string[] = []
      if (typeof i.path === 'string' && i.path) {
        const abs = normPath(i.path, cwd)
        if (abs !== cwd) paths.push(abs)
      }
      return { paths, frags: fragments(i.pattern) }
    }
    case 'Bash':
      return commandTargets(i.command, cwd)
    case 'Git': {
      const t: Targets = { paths: [], frags: [] }
      for (const c of Array.isArray(i.commands) ? i.commands : []) {
        const x = commandTargets(c, cwd)
        t.paths.push(...x.paths)
        t.frags.push(...x.frags)
      }
      return t
    }
    case 'LSP':
      return { paths: [normPath(i.filePath ?? i.file_path ?? '', cwd)].filter(Boolean), frags: [] }
    case 'WebFetch':
      return { paths: [], frags: [String(i.url ?? '').toLowerCase()].filter(Boolean) }
    case 'WebSearch':
      return { paths: [], frags: [String(i.query ?? '').toLowerCase()].filter(Boolean) }
    case 'Skill':
      return { paths: [], frags: [String(i.skill ?? '').toLowerCase()].filter(Boolean) }
    default:
      if (META_TOOLS.has(u.name)) return { paths: [], frags: [] }
      return null
  }
}

/** Files an EDIT use writes; newFiles need no prior read. */
function editTargets(u: Use, cwd: string): { paths: string[]; newFiles: string[]; unknown: boolean } {
  const i = u.input
  switch (u.name) {
    case 'Edit':
    case 'MultiEdit':
      return { paths: [normPath(i.file_path, cwd)], newFiles: [], unknown: false }
    case 'NotebookEdit':
      return { paths: [normPath(i.notebook_path, cwd)], newFiles: [], unknown: false }
    case 'Write': {
      const created = !!u.res && u.res.text.startsWith('File created successfully')
      const p = normPath(i.file_path, cwd)
      return created ? { paths: [], newFiles: [p], unknown: false } : { paths: [p], newFiles: [], unknown: false }
    }
    case 'apply_patch':
    case 'Patch': {
      const p = patchFiles(i.patchText ?? i.patch ?? i.input, cwd)
      return { paths: p.update, newFiles: p.add, unknown: p.update.length + p.add.length === 0 }
    }
    case 'Bash': {
      const k = analyzeCommand(i.command)
      if (!k.write) return { paths: [], newFiles: [], unknown: false }
      const t = commandTargets(i.command, cwd).paths
      return { paths: t, newFiles: [], unknown: t.length === 0 }
    }
    case 'Git': {
      if (!useKind(u).write) return { paths: [], newFiles: [], unknown: false }
      const t = inputPaths(u, cwd)
      return { paths: t, newFiles: [], unknown: t.length === 0 }
    }
    default:
      return { paths: [], newFiles: [], unknown: false }
  }
}

/** Files whose content the model has after this use (the read gate's "known"). */
function knownAfter(u: Use, cwd: string): string[] {
  if (!u.res || failed(u)) return []
  switch (u.name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'apply_patch':
    case 'Patch':
      return inputPaths(u, cwd)
    case 'Bash': {
      const head = String(u.input.command ?? '').trim().split(WS_SPLIT_RE)[0] ?? ''
      if (READ_COMMAND_RE.test(head)) return commandTargets(u.input.command, cwd).paths
      return []
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// REACT relatedness + cause
// ---------------------------------------------------------------------------

function cmdHead2(cmd: unknown): string {
  let s = String(cmd ?? '').trim()
  s = s.replace(CD_PREFIX_RE, '').replace(ENV_PREFIX_RE, '')
  return s.split(WS_SPLIT_RE).slice(0, 2).join(' ')
}

function stem(p: string): string {
  const b = p.split('/').pop() ?? p
  return b.replace(TEST_INFIX_RE, '.').replace(EXTENSION_RE, '').toLowerCase()
}

/** Whether k's use `uk` answers k-1's failed use `up`. */
function related(uk: Use, up: Use, cwd: string): boolean {
  const pk = inputPaths(uk, cwd)
  const pp = inputPaths(up, cwd)
  if (pk.some(p => pp.includes(p))) return true
  const t = up.res?.text ?? ''
  // Bash redirect refusal → the named tool was used
  const m = REDIRECT_AVAILABLE_RE.exec(t)
  if (m && (uk.name === m[1] || uk.name === m[2])) return true
  if (uk.name === up.name) {
    if (uk.name === 'Bash') return cmdHead2(uk.input.command) === cmdHead2(up.input.command)
    if (uk.name === 'Git') return cmdHead2(first(uk.input.commands ?? [])) === cmdHead2(first(up.input.commands ?? []))
    if (pk.length === 0 || pp.length === 0) return true
  }
  // a path named in the error text (test failures name files)
  const errPaths = (t.match(PATH_IN_TEXT_RE) ?? []).slice(0, 200)
  if (errPaths.length && pk.length) {
    const stems = new Set(errPaths.map(p => stem(p)))
    if (pk.some(p => stems.has(stem(p)))) return true
  }
  // basename of the failed target used in k's input (e.g. Glob for a missing file)
  const ks = JSON.stringify(uk.rawInput ?? {}).toLowerCase()
  for (const p of pp) {
    const b = (p.split('/').pop() ?? '').toLowerCase()
    if (b.length >= 5 && b.includes('.') && ks.includes(b)) return true
  }
  // verify failure → k re-verifies or edits (a fix)
  if (isVerifyUse(up)) {
    const kk = useKind(uk)
    if (kk.verify || kk.write) return true
  }
  return false
}

function reactCause(u: Use): string {
  const r = u.res
  if (!r) return 'other: misc'
  const t = r.text
  if (!r.isError) return 'test/typecheck/build failure'
  if (READ_GATE_RE.test(t)) return 'read gate'
  if (EDIT_MISMATCH_RE.test(t)) return 'edit mismatch (string/hunk not found)'
  if (PLAN_MODE_RE.test(t)) return 'plan-mode refusal'
  if (BLOCKED_RE.test(t.trimStart())) {
    if (SLEEP_WORD_RE.test(t.slice(0, 120)) && !AVAILABLE_RE.test(t)) return 'Bash refusal (sleep/blocking)'
    return 'Bash redirect refusal'
  }
  if (DENIAL_RE.test(t)) return 'permission/classifier denial'
  if (isVerifyUse(u)) return 'test/typecheck/build failure'
  if (PATH_MISSING_RE.test(t)) return 'other: path not found'
  if (INVALID_INPUT_RE.test(t)) return 'other: invalid input/tool'
  if (EXIT_CODE_RE.test(t.trimStart())) return 'other: command failed (exit≠0)'
  if (u.name === 'WebFetch' || u.name === 'WebSearch') return 'other: fetch failed'
  return 'other: misc'
}

// ---------------------------------------------------------------------------
// Per-thread walk
// ---------------------------------------------------------------------------

type HumanClass = 'human' | 'interrupt' | 'compact' | 'notify' | 'meta'

function classifyUser(r: Json): HumanClass {
  if (r.isCompactSummary) return 'compact'
  if (r.isMeta) return 'meta'
  const t = contentText(msgOf(r).content).trimStart()
  if (t.startsWith('[Request interrupted')) return 'interrupt'
  if (t.startsWith('<task-notification>')) return 'notify'
  if (META_USER_TAG_RE.test(t)) return 'meta'
  return 'human'
}

function toolSearchLoaded(u: Use): string[] {
  const out = new Set<string>()
  const tur = u.res?.tur
  const m = isObj(tur) ? tur.matches : undefined
  if (Array.isArray(m)) for (const x of m) if (typeof x === 'string') out.add(x)
  const text = u.res?.text ?? ''
  for (const x of text.matchAll(TOOL_REFERENCE_RE)) out.add(x[1])
  for (const x of text.matchAll(NAME_FIELD_RE)) out.add(x[1])
  return [...out]
}

function parseRecords(raw: string, ctx: Ctx): Json[] {
  const recs: Json[] = []
  let start = 0
  while (start < raw.length) {
    let end = raw.indexOf('\n', start)
    if (end < 0) end = raw.length
    const line = raw.slice(start, end)
    start = end + 1
    if (!line) continue
    try {
      const v: unknown = JSON.parse(line)
      if (isObj(v)) recs.push(v)
    } catch {
      ctx.parseErrors++
    }
  }
  return recs
}

function processThread(f: ThreadFile, raw: string, ctx: Ctx): Thread | null {
  const recs = parseRecords(raw, ctx)

  if (f.kind === 'compact') {
    const seen = new Set<string>()
    for (const r of recs) {
      const id = r.type === 'assistant' ? messageId(r) : ''
      if (!id || seen.has(id) || msgOf(r).model === '<synthetic>') continue
      seen.add(id)
      if (!ctx.claimed.has(id)) {
        ctx.claimed.add(id)
        ctx.compactionCalls++
      }
    }
    return null
  }

  // Pass A: index messages and results
  const msgs = new Map<string, { blocks: Json[]; model: string; toolIds: Set<unknown> }>()
  const results = new Map<string, Res>()
  let cwd = ''
  for (const r of recs) {
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd
    const message = msgOf(r)
    const content = message.content
    const id = r.type === 'assistant' ? messageId(r) : ''
    if (id) {
      let m = msgs.get(id)
      if (!m) {
        m = { blocks: [], model: String(message.model ?? ''), toolIds: new Set() }
        msgs.set(id, m)
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b)) continue
          if (b.type === 'tool_use') {
            if (m.toolIds.has(b.id)) continue
            m.toolIds.add(b.id)
          }
          m.blocks.push(b)
        }
      }
    } else if (r.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && !results.has(b.tool_use_id)) {
          results.set(b.tool_use_id, { text: contentText(b.content), isError: b.is_error === true, tur: r.toolUseResult })
        }
      }
    }
  }
  // Only transcripts with no assistant message lack a cwd; it is a guess for those.
  cwd = cwd || REPO_ROOT

  const t: Thread = {
    f,
    cwd,
    calls: [],
    humanPrompts: 0,
    turnsWithCalls: new Set(),
    corpus: '',
    firstKnown: new Map(),
    hasDeferredInfo: false,
    firstRead: new Map(),
    readSeqs: new Map(),
  }

  // Pass B: sequential walk
  const chunks: string[] = []
  let clen = 0
  const push = (s: string): void => {
    if (!s) return
    const x = s.toLowerCase() + '\n'
    chunks.push(x)
    clen += x.length
  }
  let turn = 0
  let broken = true
  let resetPos = 0
  let promptStart = 0
  let promptEnd = 0
  let last: Call | null = null
  const started = new Set<string>()
  let seq = 0
  const deferredEvents: { seq: number; names: string[]; removed: string[] }[] = []

  for (const r of recs) {
    if (r.type === 'assistant') {
      const id = messageId(r)
      if (!id || started.has(id)) continue
      started.add(id)
      const m = msgs.get(id)
      if (!m) continue
      if (m.model === '<synthetic>') {
        ctx.syntheticSkipped++
        continue
      }
      const owned = !ctx.claimed.has(id)
      ctx.claimed.add(id)
      const call: Call = {
        id,
        t,
        seq: seq++,
        owned,
        model: m.model,
        uses: [],
        turn,
        prev: !broken && last ? last : null,
        posStart: clen,
        posAfterInputs: 0,
        resetPos,
        promptStart,
        promptEnd,
        base: 'FINAL',
        primary: 'FINAL',
        reactCause: null,
        flags: new Set(),
      }
      for (const b of m.blocks) {
        if (b.type === 'text' && typeof b.text === 'string') push(b.text)
        else if (b.type === 'thinking' && typeof b.thinking === 'string') push(b.thinking)
        else if (b.type === 'tool_use') {
          const rawInput = b.input ?? {}
          call.uses.push({
            name: String(b.name ?? ''),
            rawInput,
            input: isObj(rawInput) ? rawInput : {},
            res: typeof b.id === 'string' ? (results.get(b.id) ?? null) : null,
          })
          push(`${String(b.name)} ${JSON.stringify(rawInput)}`)
        }
      }
      call.posAfterInputs = clen
      broken = false
      last = call
      t.calls.push(call)
      if (owned) t.turnsWithCalls.add(turn)
    } else if (r.type === 'user') {
      const content = msgOf(r).content
      if (Array.isArray(content) && content.some(b => isObj(b) && b.type === 'tool_result')) {
        for (const b of content) {
          if (!isObj(b)) continue
          if (b.type === 'tool_result') {
            const tx = contentText(b.content)
            push(tx)
            if (tx.startsWith('[Request interrupted')) broken = true
          } else if (b.type === 'text' && typeof b.text === 'string') push(b.text)
        }
        continue
      }
      const cls = classifyUser(r)
      if (cls === 'compact') resetPos = clen
      if (cls === 'human') promptStart = clen
      push(contentText(content))
      if (cls === 'human') {
        promptEnd = clen
        turn++
        broken = true
        t.humanPrompts++
      } else if (cls === 'interrupt' || cls === 'compact') broken = true
    } else if (r.type === 'attachment') {
      const rawAttachment = r.attachment ?? {}
      const a = isObj(rawAttachment) ? rawAttachment : {}
      if (a.type === 'deferred_tools_delta') {
        t.hasDeferredInfo = true
        deferredEvents.push({ seq, names: strings(a.addedNames), removed: strings(a.removedNames) })
        continue
      }
      push(JSON.stringify(rawAttachment))
    } else if (r.type === 'system' && r.subtype === 'compact_boundary') {
      broken = true
      resetPos = clen
    }
  }
  t.corpus = chunks.join('')

  // Known-file index (first call seq after which a file's content is known)
  for (const c of t.calls) {
    for (const u of c.uses) {
      for (const p of knownAfter(u, cwd)) {
        const k = p.toLowerCase()
        if (!t.firstKnown.has(k)) t.firstKnown.set(k, c.seq)
      }
      if (u.name === 'Read' && u.res && !failed(u)) {
        for (const p of inputPaths(u, cwd)) {
          const k = p.toLowerCase()
          if (!t.firstRead.has(k)) t.firstRead.set(k, c.seq)
          const l = t.readSeqs.get(k) ?? []
          l.push(c.seq)
          t.readSeqs.set(k, l)
        }
      }
    }
  }

  // Deferred-tool tracking (per thread, in call order)
  let ev = 0
  const deferred = new Set<string>()
  const loaded = new Set<string>()
  for (const c of t.calls) {
    for (; ev < deferredEvents.length && deferredEvents[ev].seq <= c.seq; ev++) {
      for (const n of deferredEvents[ev].names) deferred.add(n)
      for (const n of deferredEvents[ev].removed) deferred.delete(n)
    }
    for (const u of c.uses) {
      if (u.name === 'ToolSearch') {
        for (const n of toolSearchLoaded(u)) loaded.add(n)
        continue
      }
      if (!c.owned) continue
      if (deferred.has(u.name) && !loaded.has(u.name)) ctx.deferredNoSearch.push({ thread: t, call: c, use: u })
    }
  }
  return t
}

// ---------------------------------------------------------------------------
// Levers
// ---------------------------------------------------------------------------

const head3 = (s: unknown): string => String(s ?? '').trim().replace(CD_PREFIX_RE, '').split(WS_SPLIT_RE).slice(0, 3).join(' ')

/** Tool + command head of a check, to tell a re-run of k-1's check from a new step. */
function verifySig(u: Use): string {
  const i = u.input
  if (u.name === 'Bash') return `Bash:${head3(i.command)}`
  if (u.name === 'RunTests') return `RunTests:${i.path ?? i.command ?? ''}`
  if (u.name === 'Typecheck') return `Typecheck:${i.path ?? ''}`
  return u.name
}

function evaluate(t: Thread): void {
  const cwd = t.cwd
  const firstIndex = new Map<string, number>()
  const seenBefore = (needles: string[], from: number, to: number): boolean =>
    needles.some(n => {
      const key = `${from}\u0000${n}`
      let i = firstIndex.get(key)
      if (i === undefined) {
        i = t.corpus.indexOf(n, from)
        firstIndex.set(key, i)
      }
      return i >= 0 && i + n.length <= to
    })

  for (const c of t.calls) {
    c.base = baseLabel(c)
    c.primary = c.base
  }
  for (const c of t.calls) {
    if (!c.owned) continue
    const p = c.prev
    // REACT
    if (c.base !== 'FINAL' && c.base !== 'META' && p && p.uses.length) {
      const failedUses = p.uses.filter(u => failed(u))
      for (const up of failedUses) {
        if (c.uses.some(uk => related(uk, up, cwd))) {
          c.primary = 'REACT'
          c.reactCause = reactCause(up)
          break
        }
      }
      // Every tool in k-1 failed: k had nothing but the error to act on.
      if (c.primary !== 'REACT' && failedUses.length > 0 && failedUses.length === p.uses.length) {
        c.primary = 'REACT'
        c.reactCause = reactCause(failedUses[0])
        c.flags.add('REACT:all-failed-rule')
      }
    }
    // M-task (independent of prev)
    if (c.uses.length && c.uses.every(u => TASK_TOOLS.has(u.name))) c.flags.add('M-task')
    if (!p || !p.uses.length) continue
    const pFailed = p.uses.some(u => failed(u))
    // M-chain
    if ((c.primary === 'VERIFY' || c.primary === 'COMMIT') && (p.base === 'EDIT' || p.base === 'VERIFY') && !pFailed) {
      c.flags.add('M-chain')
      // Re-running the verify k-1 just ran (same tool + same command head) is a
      // reaction to its output, not a step that could have been planned.
      const pv = new Set(p.uses.filter(isVerifyUse).map(verifySig))
      if (c.uses.filter(isVerifyUse).some(u => pv.has(verifySig(u)))) c.flags.add('M-chain:rerun')
      else c.flags.add('M-chain:step')
    }
    // M-toolsearch (marks the ToolSearch-only call p as the avoidable one)
    if (p.uses.every(u => u.name === 'ToolSearch')) {
      const loaded = new Set(p.uses.flatMap(u => toolSearchLoaded(u)))
      if (c.uses.some(u => loaded.has(u.name))) {
        c.flags.add('M-toolsearch(k)')
        if (p.owned) p.flags.add('M-toolsearch')
      }
    }
    // M-batch
    if (c.primary === 'ORIENT') {
      let ok = true
      let nTargets = 0
      let allBeforeP = true
      let noneInPResults = true
      let allFresh = true
      const pRes = p.uses.map(u => (u.res?.text ?? '').toLowerCase()).join('\n')
      // A Read offset near a line number k-1 printed (grep -n, Read "N→") came from k-1.
      const pLineNums: number[] = []
      for (const m of pRes.matchAll(LINE_NUMBER_RE)) pLineNums.push(Number(m[1]))
      const offsetFromP = c.uses.some(u => {
        const off = u.input.offset
        return u.name === 'Read' && typeof off === 'number' && off > 1 && pLineNums.some(n => n >= off - 20 && n <= off + 80)
      })
      // "fresh" = what the model had just seen/said when it issued k-1: k-2's
      // results (or the turn prompt when k-1 opened the turn), k-1's own
      // inputs/text, and the turn's human/Agent prompt.
      const winStart = p.prev ? p.prev.posAfterInputs : Math.max(p.resetPos, p.promptStart)
      const fresh = t.corpus.slice(winStart, p.posAfterInputs)
      const prompt = t.corpus.slice(p.promptStart, p.promptEnd)
      const isFresh = (cands: string[]): boolean => cands.some(x => fresh.includes(x) || prompt.includes(x))
      for (const u of c.uses) {
        const tg = orientTargets(u, cwd)
        if (!tg) {
          ok = false
          break
        }
        for (const abs of tg.paths) {
          nTargets++
          const cands = pathCandidates(abs, cwd)
          if (!cands.length) continue
          if (!seenBefore(cands, p.resetPos, p.posAfterInputs)) {
            ok = false
            break
          }
          if (!seenBefore(cands, p.resetPos, p.posStart)) allBeforeP = false
          if (cands.some(x => pRes.includes(x))) noneInPResults = false
          if (!isFresh(cands)) allFresh = false
        }
        if (!ok) break
        for (const fr of tg.frags) {
          nTargets++
          if (!seenBefore([fr], p.resetPos, p.posAfterInputs)) {
            ok = false
            break
          }
          if (!seenBefore([fr], p.resetPos, p.posStart)) allBeforeP = false
          if (!isFresh([fr])) allFresh = false
        }
        if (!ok) break
      }
      if (ok) {
        c.flags.add('M-batch')
        if (nTargets > 0) {
          c.flags.add('M-batch:strict')
          if (allBeforeP && noneInPResults && !offsetFromP) c.flags.add('M-batch:tight')
        }
        // Exclusive sub-buckets of the spec rule
        const reread =
          c.uses.every(u => u.name === 'Read') &&
          c.uses.every(u =>
            inputPaths(u, cwd).every(x => {
              const s = t.firstRead.get(x.toLowerCase())
              return s !== undefined && s < c.seq
            }),
          )
        let variant: string
        if (nTargets === 0) variant = 'vacuous'
        else if (reread) variant = 'reread'
        else if (allFresh && noneInPResults && !pFailed && !offsetFromP) variant = 'fresh'
        else variant = 'stale'
        c.flags.add(`M-batch:${variant}`)
        if (variant === 'reread') {
          // paging = every target was read by k-1 or k-2
          const paging = c.uses.every(u =>
            inputPaths(u, cwd).every(x => {
              const seqs = t.readSeqs.get(x.toLowerCase()) ?? []
              const lastBefore = Math.max(-1, ...seqs.filter(s => s < c.seq))
              return lastBefore >= 0 && c.seq - lastBefore <= 2
            }),
          )
          c.flags.add(paging ? 'M-batch:reread:paging' : 'M-batch:reread:older')
        }
        if (variant === 'fresh' && c.uses.every(u => u.name === 'Read')) c.flags.add('M-batch:fresh:readonly')
      }
    }
    // M-edit
    // k-1 must be edit tools only (their results carry no information beyond
    // success); a Bash/Git write (formatter, script, checkout) prints output k
    // may be reacting to.
    if (c.primary === 'EDIT' && p.base === 'EDIT' && !pFailed && p.uses.every(u => EDIT_TOOLS.has(u.name))) {
      let ok = true
      for (const u of c.uses) {
        if (!useKind(u).write) continue
        if (!EDIT_TOOLS.has(u.name)) {
          ok = false
          break
        }
        const e = editTargets(u, cwd)
        if (e.unknown) {
          ok = false
          break
        }
        for (const x of e.paths) {
          const k = t.firstKnown.get(x.toLowerCase())
          if (k === undefined || k >= p.seq) {
            ok = false
            break
          }
        }
        if (!ok) break
      }
      if (ok) c.flags.add('M-edit')
    }
  }
}

/**
 * Walks the transcripts in claim order — main threads, then sub-agents, then
 * compaction files, each by first timestamp, whatever order `files` is in —
 * and labels every call. `read` returns a transcript's raw JSONL.
 */
export function runCensus(files: readonly ThreadFile[], read: (f: ThreadFile) => string): Census {
  const ctx: Ctx = { claimed: new Set(), parseErrors: 0, syntheticSkipped: 0, compactionCalls: 0, deferredNoSearch: [] }
  const counts: Record<ThreadKind, number> = { main: 0, sub: 0, compact: 0 }
  const threads: Thread[] = []
  const ordered = [...files].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.firstTs - b.firstTs)
  for (const f of ordered) {
    counts[f.kind]++
    const t = processThread(f, read(f), ctx)
    if (!t) continue
    evaluate(t)
    t.corpus = '' // only evaluate() reads it
    threads.push(t)
  }
  const owned = (kind: ThreadKind): Call[] => threads.filter(t => t.f.kind === kind).flatMap(t => t.calls.filter(c => c.owned))
  const main = owned('main')
  const sub = owned('sub')
  return {
    files: counts,
    threads,
    main,
    sub,
    all: [...main, ...sub],
    parseErrors: ctx.parseErrors,
    syntheticSkipped: ctx.syntheticSkipped,
    compactionCalls: ctx.compactionCalls,
    deferredNoSearch: ctx.deferredNoSearch,
  }
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

const pct = (a: number, b: number): string => (b ? ((100 * a) / b).toFixed(1) + '%' : '-')

/** `claude-opus-5-5` → `opus-5.5`; the OpenAI-compatible lanes by vendor; anything else as is. */
export function modelFamily(model: string): string {
  const m = CLAUDE_MODEL_RE.exec(model)
  if (m) return `${m[1]}-${m[2]}${m[3] ? `.${m[3]}` : ''}`
  if (QWEN_RE.test(model)) return 'qwen'
  if (GLM_RE.test(model)) return 'glm'
  if (KIMI_RE.test(model)) return 'kimi'
  return model
}

/** The project slug without the `~/projects/` prefix. */
function shortProject(slug: string): string {
  for (const prefix of [`${HOME_SLUG}-projects-`, `${HOME_SLUG}-`]) {
    if (slug.startsWith(prefix) && slug.length > prefix.length) return slug.slice(prefix.length)
  }
  return slug
}

function tally<K>(m: Map<K, number>, k: K): void {
  m.set(k, (m.get(k) ?? 0) + 1)
}

function byCount(m: Map<string, number>): string {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')
}

function useBrief(u: Use, cwd: string): string {
  const i = u.input
  const rp = (p: unknown): string => relPath(normPath(p, cwd), cwd)
  const mark = failed(u) ? '✗' : ''
  let s: string
  switch (u.name) {
    case 'Read': {
      const paths = [i.file_path, ...spread(i.file_paths)].filter(Boolean).map(rp).join(',')
      s = `Read(${paths}${i.offset ? `@${i.offset}` : ''}${i.symbol ? ` sym=${trunc(String(i.symbol), 20)}` : ''}${i.view ? ` ${i.view}` : ''})`
      break
    }
    case 'Grep':
      s = `Grep(${JSON.stringify(trunc(String(i.pattern ?? ''), 28))}${i.path ? ' in ' + rp(i.path) : ''})`
      break
    case 'Glob':
      s = `Glob(${trunc(String(i.pattern ?? ''), 30)})`
      break
    case 'Bash':
      s = `Bash(${trunc((String(i.command ?? '').split('\n')[0] ?? '').replace(cwd + '/', ''), 55)})`
      break
    case 'Git': {
      const cmds: unknown[] = Array.isArray(i.commands) ? i.commands : [String(i.commands ?? '')]
      s = `Git(${cmds.map(c => trunc(String(c).split('\n')[0] ?? '', 34)).join('; ')})`
      break
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      s = `${u.name}(${rp(i.file_path ?? '')})`
      break
    case 'apply_patch':
    case 'Patch': {
      const p = patchFiles(i.patchText ?? i.patch ?? '', cwd)
      s = `${u.name}(${[...p.update, ...p.add].map(x => relPath(x, cwd)).join(',')})`
      break
    }
    case 'RunTests':
      s = `RunTests(${trunc(String(i.path ?? i.command ?? ''), 50)})`
      break
    case 'Typecheck':
      s = `Typecheck(${i.path ?? ''})`
      break
    case 'ToolSearch':
      s = `ToolSearch(${i.query})`
      break
    case 'TaskUpdate':
      s = `TaskUpdate(${i.taskId ?? ''}${i.status ? ` ${i.status}` : ''})`
      break
    case 'Agent':
      s = `Agent(${i.subagent_type ?? 'fork'}: ${trunc(String(i.description ?? ''), 30)})`
      break
    default:
      s = u.name
  }
  return s + mark
}

function callLine(c: Call): string {
  const tag = [...c.flags].filter(f => !f.includes(':') && f !== 'M-toolsearch(k)').join(',')
  const body = c.uses.length ? c.uses.map(u => useBrief(u, c.t.cwd)).join(' + ') : '(text only)'
  return `    #${c.seq} ${pad(c.primary + (c.reactCause ? `[${c.reactCause}]` : ''), 10)} ${trunc(body, 230)}${tag ? `   ⇐ ${tag}` : ''}`
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const LABELS: Label[] = ['FINAL', 'META', 'REACT', 'COMMIT', 'VERIFY', 'EDIT', 'DELEGATE', 'ORIENT']
const LEVERS = [
  'M-chain',
  'M-chain:step',
  'M-chain:rerun',
  'M-toolsearch',
  'M-batch',
  'M-batch:vacuous',
  'M-batch:reread',
  'M-batch:reread:paging',
  'M-batch:reread:older',
  'M-batch:fresh',
  'M-batch:fresh:readonly',
  'M-batch:stale',
  'M-batch:tight',
  'M-edit',
  'M-task',
]
const CORE_FLAGS = ['M-chain:step', 'M-toolsearch', 'M-batch:fresh', 'M-edit', 'M-task']

const has = (c: Call, f: string): boolean => c.flags.has(f)
const isReact = (c: Call): boolean => c.primary === 'REACT'
const isReactPreventable = (c: Call): boolean => isReact(c) && c.reactCause !== 'test/typecheck/build failure'
const isReactHarness = (c: Call): boolean => isReact(c) && c.reactCause !== null && HARNESS_CAUSES.has(c.reactCause)
const isCore = (c: Call): boolean => CORE_FLAGS.some(f => has(c, f))

/** `projects`: the project dirs that had transcripts in range, out of `dirsWalked`. */
export type ReportMeta = { since: string; projects: readonly string[]; dirsWalked: number; excluded: readonly string[] }

/** report.md, line by line. */
export function renderReport(census: Census, meta: ReportMeta): string[] {
  const { threads, all } = census
  const G = { main: census.main, sub: census.sub }
  const out: string[] = []
  const log = (s = ''): void => {
    out.push(s)
  }
  const group = (k: ThreadKind): Thread[] => threads.filter(t => t.f.kind === k)

  // --- Corpus
  const mainThreads = group('main').filter(t => t.calls.some(c => c.owned))
  const subThreads = group('sub').filter(t => t.calls.some(c => c.owned))
  const turns = (ts: Thread[]): number => ts.reduce((a, t) => a + t.turnsWithCalls.size, 0)
  const prompts = (ts: Thread[]): number => ts.reduce((a, t) => a + t.humanPrompts, 0)
  log(`# Request census — corpus ${census.files.main} main files, ${census.files.sub} subagent files, ${census.files.compact} compaction files (since ${meta.since})`)
  log(`projects: ${meta.projects.map(shortProject).join(', ')} (${meta.projects.length} of ${meta.dirsWalked} dirs walked had transcripts); excluded sessions: ${meta.excluded.join(', ') || '(none)'}`)
  log(`parse errors: ${census.parseErrors} lines; <synthetic> assistant messages skipped: ${census.syntheticSkipped}`)
  log('')
  log('## Corpus')
  log(`| thread | sessions/threads | user turns (with ≥1 call) | API calls | calls/turn |`)
  log(`|---|---|---|---|---|`)
  log(`| main | ${mainThreads.length} sessions | ${turns(mainThreads)} (of ${prompts(mainThreads)} human prompts) | ${G.main.length} | ${(G.main.length / Math.max(1, turns(mainThreads))).toFixed(1)} |`)
  log(`| subagent | ${subThreads.length} threads (in ${new Set(subThreads.map(t => t.f.session)).size} sessions) | ${turns(subThreads)} | ${G.sub.length} | ${(G.sub.length / Math.max(1, turns(subThreads))).toFixed(1)} |`)
  log(`| compaction (not analysed) | ${census.files.compact} files | - | ${census.compactionCalls} | - |`)
  const byType = new Map<string, number>()
  for (const c of G.sub) tally(byType, c.t.f.agentType)
  log(`subagent calls by agentType: ${byCount(byType)}`)
  const mirrored = threads.reduce((a, t) => a + t.calls.filter(c => !c.owned).length, 0)
  log(`mirrored (deduped away) calls inside fork transcripts: ${mirrored}`)
  const byProject = new Map<string, number>()
  for (const c of all) tally(byProject, shortProject(c.t.f.project))
  log(`calls by project: ${[...byProject.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  log('')

  // --- Labels
  log('## Primary label per call')
  log(`| label | main | % | subagent | % | all | % |`)
  log(`|---|---|---|---|---|---|---|`)
  for (const L of LABELS) {
    const a = G.main.filter(c => c.primary === L).length
    const b = G.sub.filter(c => c.primary === L).length
    log(`| ${L} | ${a} | ${pct(a, G.main.length)} | ${b} | ${pct(b, G.sub.length)} | ${a + b} | ${pct(a + b, all.length)} |`)
  }
  log('')

  // --- Levers
  log('## Mergeable / avoidable calls per lever (upper bounds; levers overlap)')
  log(`| lever | main | % main | subagent | % sub | all | % all |`)
  log(`|---|---|---|---|---|---|---|`)
  const row = (name: string, pred: (c: Call) => boolean): void => {
    const a = G.main.filter(pred).length
    const b = G.sub.filter(pred).length
    log(`| ${name} | ${a} | ${pct(a, G.main.length)} | ${b} | ${pct(b, G.sub.length)} | ${a + b} | ${pct(a + b, all.length)} |`)
  }
  for (const L of LEVERS) row(L, c => has(c, L))
  row('REACT (all causes)', isReact)
  row('REACT excl. test failures', isReactPreventable)
  row('REACT harness refusals (redirect, read gate, plan mode, classifier/permission, sleep)', isReactHarness)
  const U1 = (c: Call): boolean => ['M-chain', 'M-toolsearch', 'M-batch', 'M-edit', 'M-task'].some(f => has(c, f))
  const U2 = (c: Call): boolean => ['M-chain', 'M-toolsearch', 'M-batch:fresh', 'M-batch:reread', 'M-edit', 'M-task'].some(f => has(c, f))
  const U3 = (c: Call): boolean => ['M-chain', 'M-toolsearch', 'M-batch:fresh', 'M-edit', 'M-task'].some(f => has(c, f))
  row('**union M-* (M-batch spec)**', U1)
  row('union M-* (M-batch fresh+reread)', U2)
  row('**union M-* (M-batch fresh only)**', U3)
  row('**core union: M-chain:step + M-toolsearch + M-batch:fresh + M-edit + M-task**', isCore)
  row('core + reread:paging', c => isCore(c) || has(c, 'M-batch:reread:paging'))
  row('core + reread (all) + REACT harness refusals', c => isCore(c) || has(c, 'M-batch:reread') || isReactHarness(c))
  row('union M-* spec + REACT excl. tests', c => U1(c) || isReactPreventable(c))
  row('union M-* spec + REACT all', c => U1(c) || isReact(c))
  row('union M-* fresh + REACT excl. tests', c => U3(c) || isReactPreventable(c))
  log('')

  // Per-session view
  const perSession = mainThreads.map(t => {
    const sessCalls = all.filter(c => c.t.f.session === t.f.session)
    return {
      n: sessCalls.length,
      nMain: sessCalls.filter(c => c.t.f.kind === 'main').length,
      u: sessCalls.filter(U1).length,
      u3: sessCalls.filter(U3).length,
      u3Main: sessCalls.filter(c => c.t.f.kind === 'main' && U3(c)).length,
    }
  })
  const med = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : 0
  }
  log(`per session (main+its subagents): median calls ${med(perSession.map(x => x.n))} (main-only ${med(perSession.map(x => x.nMain))}), median union-spec avoidable ${med(perSession.map(x => x.u))} (${pct(perSession.reduce((a, x) => a + x.u, 0), perSession.reduce((a, x) => a + x.n, 0))} pooled), median union-fresh ${med(perSession.map(x => x.u3))} (main-only ${med(perSession.map(x => x.u3Main))})`)
  log('')

  // M-batch: what came before
  const prevLabelOf = (f: string): string => {
    const m = new Map<string, number>()
    for (const c of all) if (has(c, f) && c.prev) tally(m, c.prev.base)
    return byCount(m)
  }
  log(`M-batch k-1 base label: ${prevLabelOf('M-batch')}`)
  log(`M-batch:tight k-1 base label: ${prevLabelOf('M-batch:tight')}`)
  const vac = all.filter(c => has(c, 'M-batch') && !has(c, 'M-batch:strict')).length
  log(`M-batch with no target at all (vacuous: git status, ls, Typecheck-less…): ${vac}`)
  const orientTools = new Map<string, number>()
  for (const c of all) if (has(c, 'M-batch')) for (const u of c.uses) tally(orientTools, u.name)
  log(`M-batch tools: ${byCount(orientTools)}`)
  const chainPairs = new Map<string, number>()
  for (const c of all) if (has(c, 'M-chain') && c.prev) tally(chainPairs, `${c.prev.base}→${c.primary}`)
  log(`M-chain pairs: ${byCount(chainPairs)}`)
  const taskTools = new Map<string, number>()
  for (const c of all) if (has(c, 'M-task')) for (const u of c.uses) tally(taskTools, u.name)
  log(`M-task tools: ${[...taskTools.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  log('')

  // --- Per model family
  log('## Levers per model family (main + subagent calls)')
  log('| family | calls | 1-tool share | M-chain:step | fresh | reread | M-edit | M-task | REACT harness | core union | core+reread+harness |')
  log('|---|---|---|---|---|---|---|---|---|---|---|')
  const families = new Map<string, Call[]>()
  for (const c of all) {
    const k = modelFamily(c.model)
    const l = families.get(k) ?? []
    l.push(c)
    families.set(k, l)
  }
  for (const [k, cs] of [...families.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const n = cs.length
    const share = (pred: (c: Call) => boolean): string => pct(cs.filter(pred).length, n)
    const withTools = cs.filter(c => c.uses.length > 0)
    log(
      `| ${k} | ${n} | ${pct(withTools.filter(c => c.uses.length === 1).length, withTools.length)} | ${share(c => has(c, 'M-chain:step'))} | ${share(c => has(c, 'M-batch:fresh'))} | ${share(c => has(c, 'M-batch:reread'))} | ${share(c => has(c, 'M-edit'))} | ${share(c => has(c, 'M-task'))} | ${share(isReactHarness)} | ${share(isCore)} | ${share(c => isCore(c) || has(c, 'M-batch:reread') || isReactHarness(c))} |`,
    )
  }
  log('')

  // --- Tool calls per API call
  log('## Tool calls per API call')
  log(`| tool_use blocks | main | % | subagent | % |`)
  log(`|---|---|---|---|---|`)
  const buckets: [string, (n: number) => boolean][] = [
    ['0 (FINAL)', n => n === 0],
    ['1', n => n === 1],
    ['2', n => n === 2],
    ['3–5', n => n >= 3 && n <= 5],
    ['6+', n => n >= 6],
  ]
  for (const [name, pred] of buckets) {
    const a = G.main.filter(c => pred(c.uses.length)).length
    const b = G.sub.filter(c => pred(c.uses.length)).length
    log(`| ${name} | ${a} | ${pct(a, G.main.length)} | ${b} | ${pct(b, G.sub.length)} |`)
  }
  const mean = (xs: Call[]): string => {
    const withTools = xs.filter(c => c.uses.length)
    return (withTools.reduce((a, c) => a + c.uses.length, 0) / Math.max(1, withTools.length)).toFixed(2)
  }
  log(`mean tool_use per tool-bearing call: main ${mean(G.main)}, subagent ${mean(G.sub)}`)
  log('')

  // --- ToolSearch
  log('## ToolSearch')
  const tsUses = all.flatMap(c => c.uses.filter(u => u.name === 'ToolSearch').map(u => ({ c, u })))
  const tsTargets = new Map<string, number>()
  let selectQ = 0
  for (const { u } of tsUses) {
    if (String(u.input.query ?? '').startsWith('select:')) selectQ++
    for (const n of toolSearchLoaded(u)) tally(tsTargets, n)
  }
  const tsOnly = all.filter(c => c.uses.length && c.uses.every(u => u.name === 'ToolSearch'))
  log(`ToolSearch uses ${tsUses.length} (select: ${selectQ}), in ${new Set(tsUses.map(x => x.c.id)).size} calls; ToolSearch-only calls ${tsOnly.length} (main ${tsOnly.filter(c => c.t.f.kind === 'main').length}), of which followed by use of a loaded tool (M-toolsearch) ${all.filter(c => has(c, 'M-toolsearch')).length}`)
  log(`top loaded tools: ${[...tsTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  const dns = census.deferredNoSearch
  const dnsTools = new Map<string, { n: number; ok: number }>()
  for (const x of dns) {
    const e = dnsTools.get(x.use.name) ?? { n: 0, ok: 0 }
    e.n++
    if (x.use.res && !x.use.res.isError) e.ok++
    dnsTools.set(x.use.name, e)
  }
  const dnsOk = dns.filter(x => x.use.res && !x.use.res.isError).length
  log(`deferred tools called WITHOUT a prior ToolSearch (threads with deferred_tools_delta only: ${threads.filter(t => t.hasDeferredInfo).length}/${threads.length}): ${dns.length} uses, ${dnsOk} succeeded (${pct(dnsOk, dns.length)}); main ${dns.filter(x => x.thread.f.kind === 'main').length}, sub ${dns.filter(x => x.thread.f.kind === 'sub').length}`)
  log(`  by tool: ${[...dnsTools.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(', ')}`)
  const dnsErr = new Map<string, number>()
  for (const x of dns) {
    if (!x.use.res?.isError) continue
    tally(dnsErr, x.use.res.text.replace(ABS_PATH_RE, '<P>').replace(DIGITS_RE, 'N').slice(0, 70))
  }
  log(`  failing ones: ${[...dnsErr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${v}× ${k}`).join(' | ')}`)
  log('')

  // --- REACT causes
  log('## REACT causes (k-1 error that k retried/fixed)')
  log(`| cause | main | subagent | all | % of all calls |`)
  log(`|---|---|---|---|---|`)
  const causes = new Map<string, { m: number; s: number }>()
  for (const c of all) {
    if (c.primary !== 'REACT' || c.reactCause === null) continue
    const e = causes.get(c.reactCause) ?? { m: 0, s: 0 }
    if (c.t.f.kind === 'main') e.m++
    else e.s++
    causes.set(c.reactCause, e)
  }
  for (const [k, v] of [...causes.entries()].sort((a, b) => b[1].m + b[1].s - a[1].m - a[1].s)) log(`| ${k} | ${v.m} | ${v.s} | ${v.m + v.s} | ${pct(v.m + v.s, all.length)} |`)
  // Redirect refusals: which tool the harness pointed to, and what k did
  const redirTo = new Map<string, number>()
  const redirK = new Map<string, number>()
  for (const c of all) {
    if (c.reactCause !== 'Bash redirect refusal' || !c.prev) continue
    for (const up of c.prev.uses.filter(u => failed(u))) {
      const m = SUGGESTED_TOOL_RE.exec(up.res?.text ?? '')
      if (m) tally(redirTo, m[1])
    }
    tally(redirK, c.uses.map(u => u.name).join('+'))
  }
  log(`redirect refusals → suggested tool: ${byCount(redirTo)}`)
  log(`redirect refusals → what k called: ${[...redirK.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  // Read-gate: which gate
  const gate = new Map<string, number>()
  for (const c of all) {
    if (c.reactCause !== 'read gate' || !c.prev) continue
    const up = c.prev.uses.find(u => failed(u))
    if (!up) continue
    const t = up.res?.text ?? ''
    tally(gate, PARTIAL_READ_RE.test(t) ? 'partial read' : MODIFIED_SINCE_RE.test(t) ? 'modified since read' : NEVER_READ_RE.test(t) ? 'never read' : 'other')
  }
  log(`read-gate REACT by gate: ${byCount(gate)}`)
  const afterFail = all.filter(c => c.base !== 'FINAL' && c.base !== 'META' && c.prev && c.prev.uses.some(u => failed(u)))
  log(`REACT via the "every k-1 tool failed" rule: ${all.filter(c => c.flags.has('REACT:all-failed-rule')).length}; any non-FINAL/META call right after a failed call (REACT ceiling): ${afterFail.length} (${pct(afterFail.length, all.length)})`)
  const redirAgain = all.filter(c => c.reactCause === 'Bash redirect refusal' && c.uses.some(u => u.res && BLOCKED_RE.test(u.res.text.trimStart()))).length
  log(`redirect REACT calls that were themselves blocked again: ${redirAgain}`)
  // Diagnostics
  const editCalls = all.filter(c => c.base === 'EDIT')
  const failedEdits = editCalls.filter(c => c.uses.some(u => failed(u))).length
  log(`EDIT calls with a failed tool (cost of chaining a verify behind an edit): ${failedEdits}/${editCalls.length} (${pct(failedEdits, editCalls.length)})`)
  const allUses = all.flatMap(c => c.uses)
  const batchRead = allUses.filter(u => u.name === 'Read' && Array.isArray(u.input.file_paths))
  log(`batch Read (file_paths) uses: ${batchRead.length}; Read uses total ${allUses.filter(u => u.name === 'Read').length}`)
  const sig = (c: Call): string => JSON.stringify(c.uses.map(u => [u.name, u.rawInput]))
  const dup = all.filter(c => c.prev && c.uses.length && sig(c) === sig(c.prev))
  const dupLabels = new Map<string, number>()
  for (const c of dup) tally(dupLabels, c.primary)
  log(`calls identical to k-1 (same tools+inputs): ${dup.length} (${pct(dup.length, all.length)}); by label ${[...dupLabels.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  log(`main threads with deferred_tools_delta info: ${threads.filter(t => t.f.kind === 'main' && t.hasDeferredInfo).length}/${group('main').length}`)
  // errors that were NOT followed by a REACT (for context)
  const errUses = allUses.filter(u => failed(u))
  log(`failed tool uses in owned calls: ${errUses.length} (is_error ${errUses.filter(u => u.res?.isError).length}, semantic ✗/⚠ ${errUses.filter(u => !u.res?.isError).length}); calls with ≥1 failed use: ${all.filter(c => c.uses.some(u => failed(u))).length}`)
  log('')

  // --- Examples
  log('## Examples (main threads)')
  const exampleFor = (flag: string, pred: (c: Call) => boolean, n: number): void => {
    const cands = G.main.filter(pred)
    // prefer runs: pick calls whose thread has many of the same flag, spread across sessions
    const bySession = new Map<string, Call[]>()
    for (const c of cands) {
      const l = bySession.get(c.t.f.session) ?? []
      l.push(c)
      bySession.set(c.t.f.session, l)
    }
    const ranked = [...bySession.entries()].sort((a, b) => b[1].length - a[1].length)
    log(`### ${flag} — ${cands.length} main calls; top sessions: ${ranked.slice(0, 5).map(([s, l]) => `${s.slice(0, 8)}(${l.length})`).join(', ')}`)
    for (const [s, l] of ranked.slice(0, n)) {
      // find a window with a dense run
      const t = l[0].t
      let best = l[0]
      let bestScore = -1
      for (const c of l) {
        const score = l.filter(x => Math.abs(x.seq - c.seq) <= 3).length
        if (score > bestScore) {
          bestScore = score
          best = c
        }
      }
      const lo = Math.max(0, best.seq - 3)
      const hi = Math.min(t.calls.length - 1, best.seq + 2)
      log(`  session ${s} (${shortProject(t.f.project)}), calls #${lo}–#${hi}:`)
      for (let i = lo; i <= hi; i++) {
        const c = t.calls[i]
        if (c.turn !== best.turn) continue
        log(callLine(c))
      }
    }
  }
  exampleFor('M-batch:fresh', c => has(c, 'M-batch:fresh'), 3)
  exampleFor('M-batch:reread', c => has(c, 'M-batch:reread'), 2)
  exampleFor('M-batch:stale', c => has(c, 'M-batch:stale'), 2)
  exampleFor('M-chain', c => has(c, 'M-chain'), 3)
  exampleFor('M-edit', c => has(c, 'M-edit'), 2)
  exampleFor('M-task', c => has(c, 'M-task'), 2)
  exampleFor('M-toolsearch', c => has(c, 'M-toolsearch'), 2)
  exampleFor('REACT read gate', c => c.reactCause === 'read gate', 2)
  exampleFor('REACT redirect', c => c.reactCause === 'Bash redirect refusal', 1)
  return out
}

/** samples.txt: seeded random calls per lever and per REACT cause, each with the calls before it. */
export function renderSamples(census: Census): string[] {
  const { all } = census
  let seed = 42
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const sample: string[] = []
  const errHead = (c: Call): string =>
    (c.prev?.uses ?? [])
      .filter(u => failed(u))
      .map(u => trunc((u.res?.text ?? '').replace(HOME_PROJECT_RE, ''), 150))
      .join(' || ')
  const sampleFor = (name: string, pred: (c: Call) => boolean, n: number, withErr = false): void => {
    const cands = all.filter(pred)
    sample.push(`\n### ${name} (${cands.length})`)
    for (let i = 0; i < n && cands.length; i++) {
      const c = cands[Math.floor(rnd() * cands.length)]
      sample.push(`  -- ${c.t.f.kind === 'main' ? c.t.f.session.slice(0, 8) : c.t.f.session.slice(0, 8) + '/' + c.t.f.agentId.slice(0, 12)} #${c.seq}`)
      const lo = Math.max(0, c.seq - 2)
      for (let j = lo; j <= c.seq; j++) {
        const x = c.t.calls[j]
        if (x.turn === c.turn) sample.push(callLine(x))
      }
      if (withErr) sample.push(`      k-1 error: ${errHead(c)}`)
    }
  }
  for (const f of ['M-chain', 'M-edit', 'M-task', 'M-toolsearch', 'M-batch:fresh', 'M-batch:reread', 'M-batch:stale', 'M-batch:vacuous']) {
    sampleFor(f, c => c.flags.has(f) || (f === 'M-toolsearch' && c.flags.has('M-toolsearch(k)')), 8)
  }
  const causes = new Set<string>()
  for (const c of all) if (c.reactCause) causes.add(c.reactCause)
  for (const cause of causes) sampleFor(`REACT ${cause}`, c => c.reactCause === cause, 6, true)
  // Failed k-1 NOT followed by a REACT (recall check)
  sampleFor('NOT REACT although k-1 failed', c => !c.reactCause && c.base !== 'FINAL' && c.base !== 'META' && !!c.prev && c.prev.uses.some(u => failed(u)), 10, true)
  return sample
}

/** One calls.jsonl row per owned call. */
export function callRows(census: Census): Json[] {
  return census.all.map(c => ({
    thread: c.t.f.kind === 'main' ? c.t.f.session : `${c.t.f.session}/${c.t.f.agentId}`,
    kind: c.t.f.kind,
    agentType: c.t.f.agentType,
    project: c.t.f.project,
    seq: c.seq,
    turn: c.turn,
    model: c.model,
    base: c.base,
    primary: c.primary,
    reactCause: c.reactCause,
    nTools: c.uses.length,
    tools: c.uses.map(u => u.name),
    brief: c.uses.map(u => useBrief(u, c.t.cwd)),
    flags: [...c.flags],
    prevSeq: c.prev?.seq ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Args = { since: string; projects: string[]; exclude: string[]; out: string | null }

const FLAGS = ['since', 'projects', 'exclude-session', 'out']

export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>()
  for (const a of argv) {
    const flag = FLAGS.find(f => a.startsWith(`--${f}=`))
    if (!flag) throw new Error(`unknown argument: ${a}\n${USAGE}`)
    values.set(flag, a.slice(flag.length + 3))
  }
  const list = (k: string): string[] =>
    (values.get(k) ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  const since = values.get('since') ?? ''
  if (!DATE_RE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00`))) throw new Error(`--since=YYYY-MM-DD is required\n${USAGE}`)
  return { since, projects: list('projects'), exclude: list('exclude-session'), out: values.get('out') || null }
}

function main(): void {
  const t0 = Date.now()
  let args: Args
  let dirs: string[]
  try {
    args = parseArgs(process.argv.slice(2))
    dirs = resolveProjectDirs(join(configDir(), 'projects'), args.projects)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
  // Local midnight, the same instant `find -newermt <date>` uses.
  const sinceMs = Date.parse(`${args.since}T00:00:00`)
  const files = discover(dirs, sinceMs, new Set(args.exclude))
  if (files.length === 0) {
    console.error(`no transcripts modified since ${args.since} under ${dirs.join(', ')}`)
    process.exit(1)
  }
  const census = runCensus(files, f => {
    try {
      return readFileSync(f.path, 'utf8')
    } catch {
      return '' // removed since discovery
    }
  })
  const withFiles = new Set(files.map(f => f.project))
  const projects = dirs.map(d => basename(d)).filter(p => withFiles.has(p))
  const report = renderReport(census, { since: args.since, projects, dirsWalked: dirs.length, excluded: args.exclude })
  const rows = callRows(census)
  const outDir = args.out ?? mkdtempSync(join(tmpdir(), 'request-census-'))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'report.md'), report.join('\n') + '\n')
  writeFileSync(join(outDir, 'calls.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(outDir, 'samples.txt'), renderSamples(census).join('\n') + '\n')
  console.log(report.join('\n'))
  console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s; wrote report.md, calls.jsonl (${rows.length} rows) and samples.txt to ${outDir}`)
}

if (import.meta.main) main()
