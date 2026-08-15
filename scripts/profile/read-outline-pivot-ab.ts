// ---------------------------------------------------------------------------
// read-outline-pivot-ab — is the auto-outline pivot worth it on band files?
// ---------------------------------------------------------------------------
//
// The corpus census (2026-08-09, 2,052 sessions / 24,741 Reads) found the
// pivot's success rate climbing monotonically with file size: 59.1% under
// 12 KB, 86.1% above 40 KB. That is correlational — big files may simply get
// read for orientation, where an outline IS the answer, while small ones get
// read to edit. This bench separates the two by holding the task fixed.
//
// Both arms read the SAME five real source files, all 20-22 KB and all over
// 250 lines, so in arm A both pivot triggers fire on every one of them and in
// arm B none do. On this fixture "pivot off" is exactly "threshold raised
// above the band", which is the decision the census could not settle.
//
//   A  pivot on   CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION=1
//   B  pivot off  CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION=1
//
// Both are forced explicitly rather than left to the build's feature flag, so
// the run does not depend on how the bundle was compiled.
//
// `--tools`, NOT `--allowedTools`. The latter is a permission allowlist that
// never reaches the registry (`getTools` filters on DENY rules only, see
// src/tools/tools.ts:383), so Grep and Bash stay in the toolset and the first run of
// this bench had arm A reach for Grep twice while arm B never did. `--tools`
// inverts the list into deny rules (permissionSetup.ts:866-876) and the tools
// are genuinely absent; `--strict-mcp-config` is required alongside it because
// `--tools` does not touch MCP tools. Measured: 40 tools visible under
// --allowedTools, exactly 2 under this pair. The mix is still reported per arm
// so a regression here is visible rather than silent.
//
// Usage:
//   bun run scripts/profile/read-outline-pivot-ab.ts \
//     [--reps=N] [--depth=deep|shallow] [--compare=pivot|wording] [--keep] [--dry-run]
//
// --compare picks WHAT the two arms differ by:
//   pivot   (default) same binary, arm A forces the auto-outline pivot ON and
//           arm B forces it OFF. Measures the mechanism.
//   wording BOTH arms force the pivot ON and the BINARY differs: arm A is the
//           published release (which serves the false "exceeds the read cap"
//           header) and arm B is this checkout (which serves "is large"). The
//           footer is byte-identical in both, so the header is the only thing
//           that changes. Measures whether the correction changes behavior.
//           Wall time is NOT comparable here — the release is a Bun-compiled
//           binary and the dev build is a chunked Node bundle.
//
// --depth picks the question set over the same five fixtures. `deep` (default)
// needs the implementation for every answer; `shallow` is answerable from the
// structural outline alone. Deep alone measures the pivot's WORST case — see
// the QUESTIONS_* comment. Results land in read-outline-pivot-ab.json for deep
// and read-outline-pivot-ab.shallow.json for shallow; never pool the two.
//
// NOTE ON REPS: agent-safety.md asks for N>=3 and a median. --reps defaults to
// 3 for that reason; a single rep is a smoke test, not a result.
// ---------------------------------------------------------------------------

import { spawnSync } from 'child_process'
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SENTINEL = 'BENCH_DONE'
const MODEL = 'claude-sonnet-5'
const ALLOWED_TOOLS = 'Read,Glob'

/** Real files, all 20-22 KB and > 250 lines: both pivot triggers fire in A. */
const FIXTURES = [
  'src/providers/usage/modelCost.ts',
  'src/tools/BashTool/sedValidation.ts',
  'src/platform/lifecycleHooks/events.ts',
  'src/mcp/doctor.ts',
  'src/sessions/sessionRestore.ts',
]

/**
 * Two question sets over the SAME five fixtures, because question depth turned
 * out to drive the result more than anything else in this bench.
 *
 * `deep` is the original set: every question needs the implementation, never a
 * signature. It was written to avoid handing the pivot arm a free win, but by
 * excluding EVERY outline-answerable question it excluded the pivot's best case
 * instead — the census measured 27.4% of real reads needing no follow-up at
 * all, and this set forces that bucket to 0%. It measures the pivot's WORST
 * case, not its typical one.
 *
 * `shallow` fills that bucket: each question is answerable from the structural
 * outline alone (exported names, signatures, line ranges, a constant whose
 * initializer the outline prints). Verified against the real `view='outline'`
 * output of each fixture before being written.
 *
 * Keep both sets frozen — the N=6 deep runs already committed are only
 * comparable to later deep runs.
 */
const QUESTIONS_DEEP = [
  'what happens when a model has no matching cost entry? Name the fallback and the exact value it uses.',
  'which sed constructs does it reject, and what is the reason given for each?',
  'list every hook event name it defines and, for three of them, when they fire.',
  'what checks does it run against an MCP server, and in what order does it stop?',
  'what does it do when the transcript it is restoring is truncated or malformed?',
]

const QUESTIONS_SHALLOW = [
  'how many COST_TIER_* constants does it declare, name them, and name the constant DEFAULT_UNKNOWN_MODEL_COST is assigned to.',
  'which functions does it export and which does it keep module-private? Name the longest function and give its line range.',
  'list every exported execute*Hooks function with its line range, and name the two has*Hook predicates that return boolean.',
  'list every exported type it declares, and name the two exported async functions whose names start with "doctor".',
  'which functions does it export and which are module-private? Name every exported async function.',
]

/** Selected by --depth in main(); every read of it happens after that. */
let DEPTH: 'deep' | 'shallow' = 'deep'
let QUESTIONS: string[] = QUESTIONS_DEEP

const DEV_BIN = join(REPO_ROOT, 'bin', 'claudin')

/**
 * The globally installed release, i.e. what `claudin` on PATH runs (as opposed
 * to `claudindev`, which is DEV_BIN). Resolved rather than hard-coded because
 * the package layout differs between the npm install and a linked checkout.
 */
function resolveReleaseBin(): string {
  const which = spawnSync('sh', ['-c', 'command -v claudin'], { encoding: 'utf8' })
  const p = (which.stdout ?? '').trim()
  if (!p) throw new Error('no `claudin` on PATH — install the release or use --binary=dev')
  const real = realpathSync(p)
  if (real === realpathSync(DEV_BIN)) {
    throw new Error(
      '`claudin` on PATH resolves to this checkout, not the published release.\n' +
        'That would compare a binary against itself. Install the npm package first.',
    )
  }
  return real
}

function buildWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'outline-ab-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const f of FIXTURES) {
    copyFileSync(join(REPO_ROOT, f), join(dir, 'src', basename(f)))
  }
  return dir
}

function buildPrompt(): string {
  const list = FIXTURES.map(
    (f, i) => `${i + 1}. src/${basename(f)} — ${QUESTIONS[i]}`,
  ).join('\n')
  return [
    'Answer the following questions about the files in src/. They are copies of',
    'real source files, so answer from what the code actually does.',
    '',
    list,
    '',
    'Cite file:line for every claim. Be specific and concise — a short paragraph',
    `per question. When you have answered all five, print ${SENTINEL} on its own line.`,
  ].join('\n')
}

type Row = { in: number; out: number; cR: number; cW: number }

function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    try {
      out.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      /* partial line */
    }
  }
  return out
}

function usageRows(events: Record<string, unknown>[]): Row[] {
  // The transcript writes one line per content block, all sharing message.id.
  // input/cache_* repeat identically, but output_tokens GROWS as the message
  // streams — so summing every line multiplies the input and cache terms,
  // while first-sighting-wins undercuts output by up to 100x. Neither is
  // uniform across arms, so neither preserves the ratio. Keep the max per id.
  const byId = new Map<string, Row>()
  let anon = 0
  for (const e of events) {
    const msg = e.message as { id?: string; usage?: Record<string, number> } | undefined
    const u = msg?.usage
    if (!u) continue
    const id = msg?.id ?? (typeof e.uuid === 'string' ? e.uuid : `anon-${anon++}`)
    const row: Row = {
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cR: u.cache_read_input_tokens ?? 0,
      cW: u.cache_creation_input_tokens ?? 0,
    }
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, out: Math.max(prev.out, row.out) } : row)
  }
  return [...byId.values()]
}

/** claude-sonnet-5 list price, USD per million tokens. */
const PRICE = { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 }

function costUsd(r: {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}): number {
  return (
    (r.input * PRICE.in +
      r.output * PRICE.out +
      r.cacheCreation * PRICE.cacheWrite +
      r.cacheRead * PRICE.cacheRead) /
    1e6
  )
}

function sessionIdFrom(events: Record<string, unknown>[]): string | null {
  for (const e of events) {
    const s = e.session_id ?? e.sessionId
    if (typeof s === 'string') return s
  }
  return null
}

function transcriptPath(sessionId: string): string | null {
  const slug = process.env.HOME
    ? join(
        process.env.HOME,
        '.claudin',
        'projects',
      )
    : null
  if (!slug) return null
  const hit = spawnSync('find', [slug, '-name', `${sessionId}.jsonl`], {
    encoding: 'utf8',
  })
  const p = (hit.stdout ?? '').split('\n')[0]?.trim()
  return p && p.length > 0 ? p : null
}

type ToolCall = {
  name: string
  input: Record<string, unknown>
  resultChars: number
  result: string
  /** Owning assistant message. Parallel calls in one batch share it. */
  msgId: string
}

function toolCallsFrom(events: Record<string, unknown>[]): ToolCall[] {
  const byId = new Map<string, ToolCall>()
  const order: string[] = []
  for (const e of events) {
    const msg = e.message as { content?: unknown; id?: unknown } | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      const blk = b as Record<string, unknown>
      if (blk.type === 'tool_use') {
        const id = String(blk.id)
        // Same duplication as usageRows. Re-setting would also wipe a result
        // already recorded, so the first sighting is the only one that counts.
        if (!byId.has(id)) {
          order.push(id)
          byId.set(id, {
            name: String(blk.name),
            input: (blk.input ?? {}) as Record<string, unknown>,
            resultChars: 0,
            result: '',
            msgId: String(msg?.id ?? ''),
          })
        }
      } else if (blk.type === 'tool_result') {
        const id = String(blk.tool_use_id)
        const call = byId.get(id)
        if (!call) continue
        let t = blk.content
        if (Array.isArray(t)) {
          t = t
            .map(x => (x as Record<string, unknown>)?.text ?? '')
            .join(' ')
        }
        call.result = String(t ?? '')
        call.resultChars = call.result.length
      }
    }
  }
  return order.map(id => byId.get(id)!).filter(Boolean)
}

function finalTextFrom(events: Record<string, unknown>[]): string {
  let last = ''
  for (const e of events) {
    if (e.type === 'result' && typeof e.result === 'string') last = e.result
    const msg = e.message as { role?: string; content?: unknown } | undefined
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      const txt = msg.content
        .filter(b => (b as Record<string, unknown>).type === 'text')
        .map(b => String((b as Record<string, unknown>).text ?? ''))
        .join('')
      if (txt.trim()) last = txt
    }
  }
  return last
}

type ArmResult = {
  label: string
  exitCode: number
  wallMs: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  costUsd: number
  turns: number
  endContext: number
  toolCalls: number
  readCalls: number
  bareReads: number
  pivots: number
  repeatReads: number
  /**
   * PRE-REGISTERED primary metric for --compare=wording. Measured at 0 across
   * eight runs while the footer named every option except this one; the dev
   * arm's footer now advertises it and the released arm's still does not.
   */
  viewFullCalls: number
  askedForBody: boolean
  /**
   * Whether the outline the model actually received advertised `view='full'`.
   * The pivot count says an outline was served, not WHICH text — a stale build
   * would put the same footer in both arms and the run would read as a clean
   * null. This is the arm's identity, checked before spending the reps.
   */
  servedFullHint: boolean
  /** Ordered reads, grouped into the assistant turn that emitted them. */
  readSeq: { turn: number; file: string; kind: string }[]
  escapeToolCalls: number
  toolMix: Record<string, number>
  readResultChars: number
  allResultChars: number
  sawSentinel: boolean
  answer: string
  stderr: string
}

function runArm(
  label: string,
  binPath: string,
  extraEnv: Record<string, string>,
  timeoutMs: number,
  keep: boolean,
): ArmResult {
  const cwd = buildWorkspace()
  const prompt = buildPrompt()
  const t0 = performance.now()
  const res = spawnSync(
    binPath,
    [
      '-p', prompt,
      '--model', MODEL,
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', ALLOWED_TOOLS,
      '--strict-mcp-config',
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: MODEL,
        // Headless -p drains auto-backgrounded sub-agents non-deterministically.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // Otherwise arm B replays arm A's tool results and reads nothing.
        CLAUDIN_DISABLE_TOOL_RESULT_CACHE: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const wallMs = performance.now() - t0
  const stdout = res.stdout ?? ''
  let events = parseJsonl(stdout)

  // The stream emits assistant events before the final usage lands; the
  // transcript is flushed after that and carries the real numbers.
  const sid = sessionIdFrom(events)
  const tPath = sid ? transcriptPath(sid) : null
  if (tPath) {
    const tEvents = parseJsonl(readFileSync(tPath, 'utf8'))
    if (toolCallsFrom(tEvents).length >= toolCallsFrom(events).length) events = tEvents
  }

  const rows = usageRows(events)
  const sums = rows.reduce(
    (a, r) => ({
      input: a.input + r.in,
      output: a.output + r.out,
      cacheRead: a.cacheRead + r.cR,
      cacheCreation: a.cacheCreation + r.cW,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  )
  const last = rows[rows.length - 1]
  const calls = toolCallsFrom(events)
  const reads = calls.filter(c => c.name === 'Read')
  const bare = reads.filter(
    c => !c.input.symbol && !c.input.view && c.input.offset === undefined && c.input.limit === undefined,
  )
  const pivots = reads.filter(c => /showing a structural outline/.test(c.result))
  // Every Read of a path beyond the first. Deliberately NOT conditioned on the
  // path having been outlined: that version is structurally 0 in the pivot-off
  // arm (no outlines ⇒ no eligible paths) and so cannot compare the two.
  const seen = new Set<string>()
  let repeats = 0
  for (const c of reads) {
    const p = String(c.input.file_path)
    if (seen.has(p)) repeats++
    seen.add(p)
  }
  // Tools the allowlist was supposed to keep out of reach. Non-zero means the
  // arm inspected a file without going through the tool under test.
  const toolMix: Record<string, number> = {}
  for (const c of calls) toolMix[c.name] = (toolMix[c.name] ?? 0) + 1
  const allowed = new Set(ALLOWED_TOOLS.split(','))
  const escapes = calls.filter(c => !allowed.has(c.name)).length

  const viewFull = reads.filter(c => c.input.view === 'full')
  // One entry per Read, numbered by the assistant turn that emitted it, so a
  // batch of parallel calls keeps one turn number. Reconstructing this from the
  // transcript by hand was needed once already; the count alone loses the shape.
  const turnOf = new Map<string, number>()
  const readSeq = reads.map(c => {
    if (!turnOf.has(c.msgId)) turnOf.set(c.msgId, turnOf.size + 1)
    const kind = c.input.view
      ? `view=${String(c.input.view)}`
      : c.input.symbol
        ? 'symbol'
        : c.input.offset !== undefined || c.input.limit !== undefined
          ? 'offset,limit'
          : 'bare'
    return { turn: turnOf.get(c.msgId)!, file: basename(String(c.input.file_path ?? '?')), kind }
  })

  if (!keep) rmSync(cwd, { recursive: true, force: true })

  return {
    label,
    exitCode: res.status ?? -1,
    wallMs,
    ...sums,
    // Cache read is the pivot arm's largest single line item, so a token count
    // that drops it is not a cost proxy. Price the four terms instead.
    costUsd: costUsd(sums),
    turns: rows.length,
    endContext: last ? last.in + last.cR + last.cW : 0,
    toolCalls: calls.length,
    readCalls: reads.length,
    bareReads: bare.length,
    pivots: pivots.length,
    repeatReads: repeats,
    viewFullCalls: viewFull.length,
    askedForBody: viewFull.length > 0,
    servedFullHint: pivots.some(c => c.result.includes("view='full'")),
    readSeq,
    escapeToolCalls: escapes,
    toolMix,
    readResultChars: reads.reduce((a, c) => a + c.resultChars, 0),
    allResultChars: calls.reduce((a, c) => a + c.resultChars, 0),
    sawSentinel: stdout.includes(SENTINEL) || finalTextFrom(events).includes(SENTINEL),
    answer: finalTextFrom(events),
    stderr: res.stderr ?? '',
  }
}

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  // Do NOT round here. An even count averages the two middle values, and
  // rounding that to an integer sends every fractional metric to zero — cost
  // came out as $0.000 on the first even-reps run this bench ever did, while
  // the integer rows looked fine. Rounding is a display concern; see fmt.
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function delta(a: number, b: number): string {
  if (a === 0) return 'n/a'
  const d = ((b - a) / a) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

function main(): void {
  const argv = process.argv.slice(2)
  const reps = Number(argv.find(a => a.startsWith('--reps='))?.split('=')[1] ?? 3)
  const keep = argv.includes('--keep')
  const timeoutMs = Number(argv.find(a => a.startsWith('--timeout='))?.split('=')[1] ?? 600_000)
  const depthArg = argv.find(a => a.startsWith('--depth='))?.split('=')[1]
  if (depthArg === 'shallow' || depthArg === 'deep') DEPTH = depthArg
  else if (depthArg) throw new Error(`--depth must be "deep" or "shallow", got "${depthArg}"`)
  QUESTIONS = DEPTH === 'deep' ? QUESTIONS_DEEP : QUESTIONS_SHALLOW

  const cmpArg = argv.find(a => a.startsWith('--compare='))?.split('=')[1] ?? 'pivot'
  if (cmpArg !== 'pivot' && cmpArg !== 'wording') {
    throw new Error(`--compare must be "pivot" or "wording", got "${cmpArg}"`)
  }
  const compare = cmpArg
  // The shallow set makes the model go straight to an explicit view='outline',
  // so the pivot never fires and the header under test is never served. That
  // combination measures nothing at all, so refuse it outright.
  if (compare === 'wording' && DEPTH !== 'deep') {
    throw new Error('--compare=wording requires --depth=deep: the shallow set never triggers the pivot')
  }

  if (argv.includes('--dry-run')) {
    const cwd = buildWorkspace()
    console.log(`workspace: ${cwd}`)
    console.log(`fixtures : ${FIXTURES.length}`)
    console.log(`model    : ${MODEL}`)
    console.log(`tools    : ${ALLOWED_TOOLS}`)
    console.log(`depth    : ${DEPTH}`)
    console.log(`compare  : ${compare}`)
    console.log(`bin A    : ${compare === 'wording' ? resolveReleaseBin() : DEV_BIN}`)
    console.log(`bin B    : ${DEV_BIN}`)
    console.log('\n--- prompt ---\n' + buildPrompt())
    if (!keep) rmSync(cwd, { recursive: true, force: true })
    return
  }

  if (reps < 3) {
    console.log(
      `\n⚠  --reps=${reps}: agent-safety.md asks for N>=3 and a median. Treat this as a smoke test.\n`,
    )
  }

  // Arm order alternates per rep, which only BALANCES on an even count: with
  // --reps=3 arm A runs first in 2 of 3 reps and pays the cold prompt cache
  // that much more often. That is a systematic, same-direction bias, and it is
  // large — an A/A control (both arms doing identical work) came out 1.25x on
  // cost under exactly this imbalance. Odd counts are fine for the metrics that
  // separate by multiples (turns, end context), not for cost.
  if (reps % 2 !== 0) {
    console.log(
      `\n⚠  --reps=${reps} is ODD: arm order cannot be balanced, so arm A runs first\n` +
        `   ${Math.ceil(reps / 2)} of ${reps} times and eats the cold cache. Do NOT read a cost\n` +
        '   delta off this run — use an even --reps for that.\n',
    )
  }

  const A: ArmResult[] = []
  const B: ArmResult[] = []
  const FORCE = { CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION: '1' }
  // In `wording` mode BOTH arms force the pivot on and only the binary differs,
  // so `pivots served` must come back 5 in each — a metric that can be non-zero
  // on both sides, which is what makes the comparison meaningful.
  const ARM_A: readonly [string, string, Record<string, string>] =
    compare === 'wording'
      ? ['A release (cap wording)', resolveReleaseBin(), FORCE]
      : ['A pivot on', DEV_BIN, FORCE]
  const ARM_B: readonly [string, string, Record<string, string>] =
    compare === 'wording'
      ? ['B dev (large wording)', DEV_BIN, FORCE]
      : ['B pivot off', DEV_BIN, { CLAUDIN_DISABLE_AUTO_OUTLINE_ON_ELISION: '1' }]
  for (let i = 0; i < reps; i++) {
    // Alternate which arm goes first. Whichever runs first pays the cold
    // prompt cache and the second inherits its warm prefix even from a
    // different cwd — worth ~19% of the gap on the first run of this bench.
    const order = i % 2 === 0 ? [ARM_A, ARM_B] : [ARM_B, ARM_A]
    for (const [label, bin, env] of order) {
      console.log(`rep ${i + 1}/${reps} — ${label}…`)
      const r = runArm(label, bin, { ...env }, timeoutMs, keep)
      ;(label === ARM_A[0] ? A : B).push(r)
    }
    // Fail on the FIRST rep, not after paying for all of them: a release binary
    // that ignored --tools or never served a pivot invalidates the whole run,
    // and would otherwise only surface in the summary.
    if (compare === 'wording' && i === 0) {
      for (const r of [A[0], B[0]]) {
        if (!r) continue
        if (r.pivots === 0) {
          throw new Error(`${r.label}: served 0 pivots — the header under test never reached the model`)
        }
        if (r.escapeToolCalls > 0) {
          throw new Error(`${r.label}: ${r.escapeToolCalls} call(s) outside "${ALLOWED_TOOLS}" — toolset gate not honored`)
        }
      }
      // Identity check on the served text, not just on "an outline appeared".
      // A stale dist/ or a release binary newer than assumed would put the same
      // footer in both arms; the run would then read as a clean null and there
      // is nothing in the numbers that would give it away afterwards.
      if (A[0] && A[0].servedFullHint) {
        throw new Error(
          `${A[0].label}: served a footer advertising view='full' — the release arm is not the pre-change text`,
        )
      }
      if (B[0] && !B[0].servedFullHint) {
        throw new Error(
          `${B[0].label}: footer never advertised view='full' — run \`bun run build\` first, dist/ is stale`,
        )
      }
    }
  }

  const pick = (arr: ArmResult[], k: keyof ArmResult): number => median(arr.map(r => Number(r[k])))

  const metrics: [string, keyof ArmResult][] = [
    ['cost USD', 'costUsd'],
    ['  input', 'input'],
    ['  output', 'output'],
    ['  cache write', 'cacheCreation'],
    ['  cache read', 'cacheRead'],
    ['assistant turns', 'turns'],
    ['end context', 'endContext'],
    ['tool calls', 'toolCalls'],
    ['  Read calls', 'readCalls'],
    ['  bare Reads', 'bareReads'],
    ['  pivots served', 'pivots'],
    ['  repeat Reads', 'repeatReads'],
    ['  view=full calls', 'viewFullCalls'],
    ['  ESCAPED allowlist', 'escapeToolCalls'],
    ['Read result chars', 'readResultChars'],
    ['all result chars', 'allResultChars'],
    ['wall ms', 'wallMs'],
  ]

  console.log(
    `\n${'metric'.padEnd(20)}${ARM_A[0].padStart(24)}${ARM_B[0].padStart(24)}${'B vs A'.padStart(10)}`,
  )
  console.log('-'.repeat(78))
  for (const [label, key] of metrics) {
    const a = pick(A, key)
    const b = pick(B, key)
    const f = key === 'costUsd' ? (n: number) => `$${n.toFixed(3)}` : fmt
    console.log(`${label.padEnd(20)}${f(a).padStart(24)}${f(b).padStart(24)}${delta(a, b).padStart(10)}`)
  }

  if (compare === 'wording') {
    // Pre-registered before the run: the old header claims the body is out of
    // reach, the new one does not. Printed on its own so it is read as the
    // result, not picked out of the table afterwards.
    const body = (arr: ArmResult[]) => `${arr.filter(r => r.askedForBody).length}/${arr.length} runs`
    console.log(
      `\nPRE-REGISTERED primary — asked for the body (view='full'):` +
        `\n  ${ARM_A[0]}: ${body(A)}  calls ${JSON.stringify(A.map(r => r.viewFullCalls))}` +
        `\n  ${ARM_B[0]}: ${body(B)}  calls ${JSON.stringify(B.map(r => r.viewFullCalls))}` +
        `\n  Wall time is NOT comparable in this mode (compiled binary vs Node bundle).` +
        `\n  N=${reps}: a null here is INCONCLUSIVE, not evidence the wording does not matter.`,
    )
  }

  console.log(
    `\ncompleted (sentinel): A ${A.filter(r => r.sawSentinel).length}/${reps}  B ${B.filter(r => r.sawSentinel).length}/${reps}`,
  )
  console.log(`exit codes         : A ${A.map(r => r.exitCode).join(',')}  B ${B.map(r => r.exitCode).join(',')}`)
  console.log(`tool mix           : A ${JSON.stringify(A.map(r => r.toolMix))}`)
  console.log(`                     B ${JSON.stringify(B.map(r => r.toolMix))}`)
  const escaped = [...A, ...B].filter(r => r.escapeToolCalls > 0)
  if (escaped.length > 0) {
    console.log(
      `\n⚠  ${escaped.length} arm(s) used a tool outside "${ALLOWED_TOOLS}" — the allowlist is a permission gate, not a\n` +
        '   registry filter. Those arms did not measure the tool under test; discard the run.',
    )
  }

  const outDir = join(REPO_ROOT, 'scripts', 'profile')
  const suffix =
    compare === 'wording' ? '.wording' : DEPTH === 'deep' ? '' : `.${DEPTH}`
  const outName = `read-outline-pivot-ab${suffix}.json`
  writeFileSync(
    join(outDir, outName),
    JSON.stringify({ model: MODEL, reps, depth: DEPTH, compare, fixtures: FIXTURES, A, B }, null, 2),
  )
  console.log(`\nfull results + both answers → scripts/profile/${outName}`)
  console.log('Token counts do not grade the ANSWERS. Read both before concluding.')
}

main()
