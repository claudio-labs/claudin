/**
 * Replays the Bash output filter over the commands the agent actually ran.
 *
 * `measure-bash-filter-roi.test.ts` answers "how well does filter X do on output
 * shaped like X" over 55 hand-mapped fixtures. It cannot answer "what fraction
 * of real traffic gets filtered at all", and the two numbers are far apart: the
 * fixture table reports 63.1% saved while the recorded sessions have the filter
 * firing on a small minority of results. This file is the second number.
 *
 * Runs as a Bun test so `src/...` imports resolve (same reason as the ROI
 * report). It ALWAYS PASSES — a report, not a gate. The regression floor lives
 * in `reductionFloors.test.ts`, which is one of the seven invariant suites and
 * runs everywhere; a gate keyed on a corpus that exists on one machine would
 * fail for everyone else.
 *
 * Build the corpus first (it lands outside the repo, see the extractor):
 *
 *   bun scripts/bench/tokens/extract-bash-corpus.ts --days 60
 *   bun test scripts/bench/tokens/measure-bash-filter-replay.test.ts
 *
 * With no corpus on disk the test logs how to make one and returns.
 *
 * ## What a replay can and cannot measure
 *
 * The transcript holds the output of the command as it RAN. So the pre-exec
 * rewrite arms — `rewriteCommand` and the trailing-reducer strip — cannot be
 * measured here at all: stripping `| tail -40` means the base command would have
 * printed MORE, and that text was never recorded. The plan is therefore built
 * with `allowRewrite: false`, which is also what keeps the numbers honest: a
 * plan claiming a rewrite that never happened would apply the dropped reducer's
 * line cap to output that already went through `tail`, and count the same lines
 * as a saving twice.
 *
 * The second blind spot is bigger and needs its own lane. A result that already
 * carries the production marker IS the filter's output, so
 * `applyBashFilterToStdout` refuses to touch it again (`ALREADY_WRAPPED_RE`) and
 * the replay reports zero for it. How much traffic that is per spec is no longer
 * asserted here: the estimate table computes it as the `pre-marked` column
 * (routed calls that arrived already wrapped). It reads 86.4% for `git-diff` and
 * 67.1% for `git-show` — an earlier version of this comment claimed 98% for
 * `git diff`, which the column contradicts. The cause is the Bash→Git redirect
 * sending atomic reads to the Git tool, so what is left in Bash arrives
 * pre-marked, and a `renderBody` stage added today measures as worth nothing
 * while in production it would run on every one of those calls. The estimate
 * section re-runs `renderBody` over the unwrapped bodies to size it. It is an
 * ESTIMATE and a conservative one: the body it sees has already lost whatever
 * the old filter took.
 *
 * The third lane is the `registry-only` arm, which replays the same corpus with
 * the floor removed so the "before" number is one run away instead of one
 * checkout away. Read its label: it is the floor's marginal share against
 * TODAY's registry, not a re-derivation of the pre-floor build.
 */
import { test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import {
  applyBashFilterToStdout,
  planBashFilter,
  type PreExecPlan,
} from 'src/tools/shared/outputFilter/Bash/index.js'
import {
  canonicalizeForMatching,
  findFilterForCommand,
} from 'src/tools/shared/outputFilter/Bash/registry.js'
import {
  applyPipeline,
  hasCompound,
  splitTopLevelSegments,
  splitTrailingReducerPipe,
} from 'src/tools/shared/outputFilter/Bash/pipeline.js'
import {
  ALREADY_WRAPPED_RE,
  stripOutputMarkers,
  wrapStdoutWithMarkers,
} from 'src/tools/shared/outputFilter/Bash/markers.js'
import {
  CORPUS_PATH,
  type CorpusEntry,
  pad,
  padLeft,
  pct,
  readCorpus,
} from './transcriptCorpus.js'

const WS_RE = /\s+/
/**
 * A leading `cd <dir> &&` is navigation, not the command being measured.
 * Stripped textually rather than via `splitTopLevelSegments`, which returns null
 * for anything holding a pipe — and `cd x && grep … | head` is the single most
 * common shape in the corpus, so asking the splitter files 16% of the traffic
 * under the head `cd`.
 */
const LEADING_CD_RE = /^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*(?:&&|;)\s*/
/** The marker attributes the production filter left behind on an entry. */
const MARKER_RE =
  /^<bash-output-(?:filtered|rewritten)(?:\s[^>]*)?>([\s\S]*)<\/bash-output-(?:filtered|rewritten)>$/
const REDUCTION_ATTR_RE = /\sreduction="(\d+)%"/
/** Subcommand-carrying binaries — `git log` is a head, `git` alone is not. */
const TWO_TOKEN_HEADS = new Set([
  'bun',
  'bunx',
  'cargo',
  'docker',
  'dotnet',
  'gh',
  'git',
  'glab',
  'go',
  'jj',
  'npm',
  'pip',
  'pnpm',
  'poetry',
  'uv',
  'yarn',
])

/** Why no filter matched — the census buckets, decided by the real helpers. */
type Gate =
  | 'filtered'
  | 'reducer pipe, base has no filter'
  | 'non-reducer pipe'
  | 'chain with disagreeing heads'
  | 'subshell or control flow'
  | 'atomic, no filter registered'

function classify(command: string): Gate {
  if (findFilterForCommand(command)) return 'filtered'
  const canon = canonicalizeForMatching(command)
  if (splitTrailingReducerPipe(canon)) return 'reducer pipe, base has no filter'
  if (!hasCompound(canon)) return 'atomic, no filter registered'
  // `splitTopLevelSegments` returns null for everything it cannot split safely:
  // pipes, subshells, backgrounding and control-flow keywords alike. A non-null
  // split that still found no filter means the segments disagreed or had none.
  const segments = splitTopLevelSegments(canon)
  if (segments) return 'chain with disagreeing heads'
  return command.includes('|') ? 'non-reducer pipe' : 'subshell or control flow'
}

function head(command: string): string {
  let subject = canonicalizeForMatching(command)
  let stripped = subject.replace(LEADING_CD_RE, '')
  while (stripped !== subject) {
    subject = canonicalizeForMatching(stripped)
    stripped = subject.replace(LEADING_CD_RE, '')
  }
  const parts = subject.split(WS_RE)
  const first = parts[0] ?? ''
  if (!TWO_TOKEN_HEADS.has(first)) return first
  const second = parts[1] ?? ''
  return second.startsWith('-') ? first : `${first} ${second}`.trim()
}

type Bucket = { calls: number; raw: number; kept: number; filtered: number }

function bucket(): Bucket {
  return { calls: 0, raw: 0, kept: 0, filtered: 0 }
}

function add(b: Bucket, raw: number, kept: number, didFilter: boolean): void {
  b.calls += 1
  b.raw += raw
  b.kept += kept
  if (didFilter) b.filtered += 1
}

function saved(b: Bucket): string {
  return pct(b.raw - b.kept, b.raw)
}

/**
 * What the production filter already removed from ONE marked entry.
 *
 * A recorded result that carries our marker is the filter's OUTPUT, so replaying
 * it correctly reports zero — the work is done. Counting that as "not covered"
 * would report the filter as doing nothing when it is in fact the only thing
 * that already fired. The marker discloses `reduction="N%"`, measured by
 * `applyPipeline` as `(origLen - bodyLen) / origLen`, so the pre-filter size is
 * recoverable: `origLen = bodyLen / (1 - N/100)`.
 *
 * Returns null when the entry carries no usable marker. N=100 is refused rather
 * than divided by — a body that reduced to nothing gives no ratio to invert.
 */
function productionSaving(entry: CorpusEntry): { raw: number; kept: number } | null {
  if (!entry.alreadyFiltered) return null
  const body = MARKER_RE.exec(entry.text)?.[1]
  if (body === undefined) return null
  const n = Number(REDUCTION_ATTR_RE.exec(entry.text)?.[1] ?? NaN)
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null
  return { raw: Math.round(body.length / (1 - n / 100)), kept: body.length }
}

/**
 * Whether any line carries a `path:line:` prefix for `groupMatchLines` to hoist.
 *
 * Mirrors `readingsOf` in `groupMatchLines.ts` deliberately, down to the
 * overlapping-match walk: a line offers a reading when the separator has at
 * least one character before it, so `:12:foo` (no path) does not count while
 * `a-1-b-2-c` does. Asking the real function instead would answer a different
 * question — it also declines on "fewer than two files" and "no file repeats" —
 * and this number exists to separate those reasons.
 */
const MATCH_SEPARATOR_RE = /[:-](\d+)[:-]/g

function carriesPathPrefix(body: string): boolean {
  for (const line of body.split('\n')) {
    if (line === '') continue
    MATCH_SEPARATOR_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MATCH_SEPARATOR_RE.exec(line)) !== null) {
      if (m.index > 0) return true
      MATCH_SEPARATOR_RE.lastIndex = m.index + 1
    }
  }
  return false
}

/**
 * The pre-floor pipeline: what a registered spec takes on its own, with none of
 * the stages `floor.ts` supplies.
 *
 * Three differences from the real path, and each one is a thing the floor added:
 * an unmatched command is passed through untouched, a failing command skips the
 * pipeline entirely (`ERROR_FLOOR` is floor), and a matched spec does NOT get
 * `stripAnsi`/`collapseRuns` filled in (`withGenericFloor` is floor). Everything
 * else — the marker wrapper included — is shared, so the two arms differ by the
 * floor and by nothing else.
 *
 * READ THE LABEL BEFORE CITING IT. This is the floor's MARGINAL share measured
 * against TODAY's registry. It is not a re-derivation of the old build's 2.3%:
 * `findFilterForCommand` itself moved when compound routing landed, so commands
 * that resolve a spec here resolved none back then. Re-deriving that number
 * needs a checkout of `main`; this arm cannot substitute for it.
 */
function registryOnlyOutput(entry: CorpusEntry, plan: PreExecPlan): string {
  if (entry.text === '') return ''
  if (entry.isError) return entry.text
  if (ALREADY_WRAPPED_RE.test(entry.text)) return entry.text
  if (!plan.filter) return entry.text
  const result = applyPipeline(plan.filter, entry.text, {
    allowShortCircuit: !plan.isCompound,
    capLines: plan.droppedReducer?.lines ?? null,
    allowRenderBody: plan.callerBudgets !== true,
  })
  return wrapStdoutWithMarkers(entry.text, plan, result)
}

test('bash filter replay over recorded sessions', () => {
  if (!existsSync(CORPUS_PATH)) {
    console.log(
      `no corpus at ${CORPUS_PATH} — build one with:\n` +
        '  bun scripts/bench/tokens/extract-bash-corpus.ts --days 60',
    )
    return
  }

  const entries = readCorpus()
  const all = bucket()
  /** Entries whose recorded text IS the raw command output. */
  const clean = bucket()
  /** Reconstructed from the markers: what the filter already did in production. */
  const production = bucket()
  /** The same replay with the floor removed — see `registryOnlyOutput`. */
  const registryOnly = bucket()
  const gates = new Map<Gate, Bucket>()
  const heads = new Map<string, Bucket>()
  let errorEntries = 0
  let errorChars = 0
  /** `renderBody` re-run over marked bodies the replay cannot otherwise reach. */
  const renderBodyEstimate = new Map<string, Bucket>()
  /**
   * Why that estimate lane is needed at all, per spec: how much of the traffic
   * routed to a `renderBody` spec arrives already carrying the marker, so the
   * replay proper reports zero for it.
   */
  const renderBodyRouting = new Map<string, { routed: number; preMarked: number }>()
  /** Of the calls routed to `grep-rg`, how many print a `path:` prefix at all. */
  let grepRouted = 0
  let grepWithPrefix = 0

  for (const entry of entries) {
    const plan = planBashFilter(entry.command, { allowRewrite: false })
    const out = applyBashFilterToStdout(entry.text, entry.isError, plan)
    const didFilter = out !== entry.text
    const raw = entry.text.length
    const kept = out.length

    add(all, raw, kept, didFilter)
    const before = registryOnlyOutput(entry, plan)
    add(registryOnly, raw, before.length, before !== entry.text)
    if (!entry.alreadyFiltered && !entry.truncatedUpstream) {
      add(clean, raw, kept, didFilter)
    }
    const already = productionSaving(entry)
    if (already) add(production, already.raw, already.kept, true)
    if (plan.filter?.renderBody) {
      const r = renderBodyRouting.get(plan.filter.name) ?? { routed: 0, preMarked: 0 }
      r.routed += 1
      if (entry.alreadyFiltered) r.preMarked += 1
      renderBodyRouting.set(plan.filter.name, r)
    }
    if (plan.filter?.name === 'grep-rg') {
      grepRouted += 1
      if (carriesPathPrefix(stripOutputMarkers(entry.text))) grepWithPrefix += 1
    }
    if (entry.alreadyFiltered) {
      const spec = findFilterForCommand(entry.command)
      if (spec?.renderBody) {
        const body = stripOutputMarkers(entry.text)
        const rendered = spec.renderBody(body)
        const b = renderBodyEstimate.get(spec.name) ?? bucket()
        add(
          b,
          body.length,
          rendered === null ? body.length : rendered.length,
          rendered !== null,
        )
        renderBodyEstimate.set(spec.name, b)
      }
    }
    if (entry.isError) {
      errorEntries += 1
      errorChars += raw
    }

    const gate = classify(entry.command)
    const g = gates.get(gate) ?? bucket()
    add(g, raw, kept, didFilter)
    gates.set(gate, g)

    const h = head(entry.command)
    const hb = heads.get(h) ?? bucket()
    add(hb, raw, kept, didFilter)
    heads.set(h, hb)
  }

  console.log(`corpus:  ${entries.length} Bash calls, ${all.raw} chars`)
  console.log(
    `already done in production: ${production.calls} calls, ` +
      `${production.raw - production.kept} chars removed before recording ` +
      `(${saved(production)} of their own pre-filter ${production.raw})`,
  )
  console.log(
    `filtered: ${all.filtered} calls (${pct(all.filtered, all.calls)}), ` +
      `${all.raw - all.kept} chars removed (${saved(all)} of Bash)`,
  )
  // The corpus records POST-filter text, so the pre-filter total is what the
  // commands actually printed: the recorded characters plus the ones production
  // had already removed from the marked entries.
  const productionRemoved = production.raw - production.kept
  const replayRemoved = all.raw - all.kept
  const preFilterChars = all.raw + productionRemoved
  console.log(
    `  → coverage today, counting both: ` +
      `${pct(production.calls + all.filtered, all.calls)} of calls, ` +
      `${pct(productionRemoved + replayRemoved, preFilterChars)} of pre-filter chars removed ` +
      `(${productionRemoved} in production + ${replayRemoved} by this build)`,
  )
  console.log(
    `  excluding already-filtered / upstream-truncated entries: ` +
      `${clean.calls} calls, ${pct(clean.filtered, clean.calls)} covered, ${saved(clean)} removed`,
  )
  console.log(
    `  error results: ${errorEntries} calls, ${errorChars} chars (${pct(errorChars, all.raw)} of Bash)`,
  )

  // The floor's marginal share, same denominator as the headline above: the
  // production term is what the recording already lost and is identical in both
  // arms, so only the "by this build" term moves.
  const registryRemoved = registryOnly.raw - registryOnly.kept
  console.log(
    `\nregistry-only arm (floor OFF, TODAY's registry — NOT the old build's baseline)`,
  )
  console.log(
    `  ${pct(production.calls + registryOnly.filtered, all.calls)} of calls, ` +
      `${pct(productionRemoved + registryRemoved, preFilterChars)} of pre-filter chars removed ` +
      `(${registryRemoved} by the specs alone)`,
  )
  console.log(
    `  → the floor is worth the difference: ` +
      `${pct(all.filtered - registryOnly.filtered, all.calls)} of calls and ` +
      `${pct(replayRemoved - registryRemoved, preFilterChars)} of pre-filter chars`,
  )
  console.log(
    `  compound routing moved findFilterForCommand itself, so this arm resolves ` +
      `specs the pre-floor build did not. Re-deriving that number needs a checkout of main.`,
  )

  if (grepRouted > 0) {
    console.log(
      `\ngrep-rg routing: ${grepRouted} calls, ` +
        `${pct(grepRouted - grepWithPrefix, grepRouted)} print no path: prefix to hoist ` +
        `(${grepWithPrefix} do) — why groupMatchLines is triggered by the body, not the spec`,
    )
  }

  if (renderBodyEstimate.size > 0) {
    console.log(
      '\nrenderBody, ESTIMATED over already-filtered bodies (invisible to the replay above)',
    )
    console.log(
      `  ${pad('spec', 16)} ${padLeft('calls', 6)} ${padLeft('routed', 7)} ${padLeft('pre-marked', 11)} ` +
        `${padLeft('before', 10)} ${padLeft('after', 10)} ${padLeft('saved', 7)} ${padLeft('%Bash', 7)}`,
    )
    for (const [name, b] of [...renderBodyEstimate.entries()].sort(
      (a, b2) => b2[1].raw - a[1].raw,
    )) {
      const routing = renderBodyRouting.get(name) ?? { routed: 0, preMarked: 0 }
      console.log(
        `  ${pad(name, 16)} ${padLeft(String(b.calls), 6)} ${padLeft(String(routing.routed), 7)} ` +
          `${padLeft(pct(routing.preMarked, routing.routed), 11)} ${padLeft(String(b.raw), 10)} ` +
          `${padLeft(String(b.kept), 10)} ${padLeft(saved(b), 7)} ${padLeft(pct(b.raw - b.kept, all.raw), 7)}`,
      )
    }
  }

  console.log('\nfirst blocking gate')
  console.log(
    `  ${pad('gate', 34)} ${padLeft('calls', 6)} ${padLeft('chars', 10)} ${padLeft('%chars', 7)} ${padLeft('saved', 7)}`,
  )
  for (const [gate, b] of [...gates.entries()].sort((a, b) => b[1].raw - a[1].raw)) {
    console.log(
      `  ${pad(gate, 34)} ${padLeft(String(b.calls), 6)} ${padLeft(String(b.raw), 10)} ` +
        `${padLeft(pct(b.raw, all.raw), 7)} ${padLeft(saved(b), 7)}`,
    )
  }

  console.log('\ntop heads by chars')
  console.log(
    `  ${pad('head', 22)} ${padLeft('calls', 6)} ${padLeft('chars', 10)} ${padLeft('%chars', 7)} ${padLeft('cover', 7)} ${padLeft('saved', 7)}`,
  )
  for (const [name, b] of [...heads.entries()]
    .sort((a, b) => b[1].raw - a[1].raw)
    .slice(0, 25)) {
    console.log(
      `  ${pad(name || '(empty)', 22)} ${padLeft(String(b.calls), 6)} ${padLeft(String(b.raw), 10)} ` +
        `${padLeft(pct(b.raw, all.raw), 7)} ${padLeft(pct(b.filtered, b.calls), 7)} ${padLeft(saved(b), 7)}`,
    )
  }
})
