/**
 * Replays the Grep summarizer over real recorded tool results.
 *
 * The recorded bodies in the session transcripts are genuine ripgrep output, so
 * this is a deterministic measurement, not a sampled A/B: it answers "what would
 * this build have saved on the searches we actually ran".
 *
 * Usage:
 *   NODE_ENV=test bun --preload ./src/stubs/test-preload.ts \
 *     scripts/profile/grep-summarizer-replay.ts [--dir <transcriptDir>] [--json]
 *
 * The preload supplies the growthbook/sandbox stubs the bundler normally
 * injects; NODE_ENV=test is what lets getGlobalConfig() run outside the app
 * boot sequence (otherwise every call fails open and the run reports 0 saved).
 *
 * Reports total chars saved, how many results stop tripping the no-win guard,
 * and a comparison of dispatch policies — including how many results each one
 * buys its bytes with, i.e. how many trade a match locator for a counter.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import {
  maybeSummarizeToolResult,
  summarizeGrepOutput,
} from '../../src/agent/tools/toolResultSummarizer.js'
import { GREP_TOOL_NAME } from '../../src/tools/GrepTool/prompt.js'
import { relativizeRgLine } from '../../src/tools/GrepTool/relativize.js'
import { buildSymbolsOutput } from '../../src/tools/GrepTool/symbolsOutput.js'
import {
  measureGrepShape,
  pivotWins,
  shouldAutoPivot,
} from '../../src/tools/GrepTool/autoPivot.js'
import { getCwd } from '../../src/shared/fs/cwd.js'

type Sample = { input: Record<string, unknown>; text: string }

const DEFAULT_DIR = join(
  homedir(),
  '.claudin',
  'projects',
  '-home-viudes-projects-claudin',
)

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) walk(full, out)
    else if (entry.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function collect(dir: string): Sample[] {
  const inputs = new Map<string, Record<string, unknown>>()
  const samples: Sample[] = []
  for (const file of walk(dir)) {
    let lines: string[]
    try {
      lines = readFileSync(file, 'utf8').split('\n')
    } catch {
      continue
    }
    for (const line of lines) {
      if (!line.trim()) continue
      let rec: unknown
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const content = (rec as { message?: { content?: unknown } })?.message
        ?.content
      if (!Array.isArray(content)) continue
      for (const blk of content) {
        if (typeof blk !== 'object' || blk === null) continue
        const b = blk as Record<string, unknown>
        if (b.type === 'tool_use' && b.name === GREP_TOOL_NAME) {
          inputs.set(
            String(b.id),
            (b.input as Record<string, unknown>) ?? {},
          )
        } else if (b.type === 'tool_result') {
          const input = inputs.get(String(b.tool_use_id))
          if (!input) continue
          let text = b.content
          if (Array.isArray(text)) {
            text = text
              .map(x =>
                typeof x === 'object' && x !== null
                  ? String((x as { text?: string }).text ?? '')
                  : '',
              )
              .join('')
          }
          if (typeof text !== 'string') continue
          if (text.includes('<tool-result-summary')) continue
          if (text.includes('<persisted-output')) continue
          if (input.output_mode !== 'content') continue
          samples.push({ input, text })
        }
      }
    }
  }
  return samples
}

/**
 * Transcripts recorded before the context-line relativization fix carry
 * absolute paths on context lines and relative paths on match lines. Replaying
 * them raw would measure the bug, not the summarizer, so every sample is first
 * normalised the way the current GrepTool emits it.
 */
function normalize(text: string): string {
  // Same anchor GrepTool relativizes against. Not process.cwd(): the session
  // cwd is realpath-resolved, so on a checkout reached through a symlink the
  // two differ and every line would silently normalize to nothing — the bench
  // would then report the path fix as saving zero.
  const root = getCwd()
  return text
    .split('\n')
    .map(line => relativizeRgLine(line, root))
    .join('\n')
}

function summarize(text: string): string {
  const out = maybeSummarizeToolResult(
    { type: 'tool_result', tool_use_id: 'replay', content: text },
    GREP_TOOL_NAME,
  )
  return typeof out.content === 'string' ? out.content : text
}

function hasContext(input: Record<string, unknown>): boolean {
  return ['-A', '-B', '-C', 'context'].some(k => input[k] !== undefined)
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`
}

/**
 * `--pivot`: evaluates the auto-pivot policy (src/tools/GrepTool/autoPivot.ts)
 * over the same recorded results.
 *
 * Two caveats the numbers carry, stated in the output as well: the recorded
 * bodies are already relativized and already past `head_limit`, so this
 * measures the emitted slice (which is the thing that costs tokens); and the
 * map is rebuilt against TODAY's tree, so a file that moved since scans as
 * missing. The population a policy admits is exact; the map size is an estimate.
 *
 * The column that decides the trade is not "saved vs raw" — the summarizer
 * already compacts these results losslessly — but "saved vs summarized", i.e.
 * what the lossy map buys ON TOP of what we already get for free.
 */
type PivotPolicy = {
  label: string
  chars: number
  matchLines: number
  files: number
}

const PIVOT_POLICIES: PivotPolicy[] = [
  { label: 'F>=5  C>=6,000  L>=60 (shipping)', chars: 6000, matchLines: 60, files: 5 },
  { label: 'F>=5  C>=6,000  L>=inf', chars: 6000, matchLines: Infinity, files: 5 },
  { label: 'F>=3  C>=6,000  L>=60', chars: 6000, matchLines: 60, files: 3 },
  { label: 'F>=5  C>=8,000  L>=60', chars: 8000, matchLines: 60, files: 5 },
  { label: 'F>=8  C>=6,000  L>=60', chars: 6000, matchLines: 60, files: 8 },
  { label: 'F>=5  C>=10,000 L>=100', chars: 10000, matchLines: 100, files: 5 },
]

function admits(p: PivotPolicy, shape: ReturnType<typeof measureGrepShape>): boolean {
  return (
    shape.files >= p.files &&
    (shape.chars >= p.chars || shape.matchLines >= p.matchLines)
  )
}

async function runPivot(samples: Sample[], dir: string): Promise<void> {
  type Acc = { pivots: number; gated: number; replaced: number; map: number; summarized: number; degraded: number }
  const acc = new Map<string, Acc>()
  for (const p of PIVOT_POLICIES) {
    acc.set(p.label, { pivots: 0, gated: 0, replaced: 0, map: 0, summarized: 0, degraded: 0 })
  }

  // Building a map costs up to SYMBOLS_MAX_FILES reads, and the corpus repeats
  // identical results across resumed sessions — memoize on the body.
  const mapCache = new Map<string, { content: string; degraded: boolean }>()
  let total = 0
  let eligible = 0

  for (const s of samples) {
    const text = normalize(s.text)
    total += text.length
    const lines = text.split('\n').filter(l => l.length > 0)
    const shape = measureGrepShape(lines, text.length)
    // Isolates the suppression half of the gate: a shape that clears every
    // threshold, so the only thing that can return false is head_limit/offset/-n.
    const suppressed = !shouldAutoPivot({
      shape: { chars: Infinity, matchLines: 0, files: Infinity },
      headLimitGiven: s.input.head_limit !== undefined,
      offset: Number(s.input.offset ?? 0),
      lineNumbers: s.input['-n'] !== false,
    })
    if (suppressed) continue
    if (!PIVOT_POLICIES.some(p => admits(p, shape))) continue
    eligible++

    let built = mapCache.get(text)
    if (!built) {
      const symbols = await buildSymbolsOutput(lines)
      built = {
        content: symbols.content,
        degraded: symbols.content.includes('(matched,'),
      }
      mapCache.set(text, built)
    }
    const summarized = summarize(text).length

    for (const p of PIVOT_POLICIES) {
      if (!admits(p, shape)) continue
      const a = acc.get(p.label)!
      if (!pivotWins(built.content.length, text.length)) {
        a.gated++
        continue
      }
      a.pivots++
      a.replaced += text.length
      a.map += built.content.length
      a.summarized += summarized
      if (built.degraded) a.degraded++
    }
  }

  console.log(`Grep auto-pivot replay — ${dir}`)
  console.log(`  results ${samples.length}, ${total.toLocaleString()} chars`)
  console.log(`  reached the map builder: ${eligible}`)
  console.log(
    '  NOTE: bodies are post-head_limit and rebuilt against today\'s tree — the admitted population is exact, the map size is an estimate.\n',
  )
  console.log(
    `    ${'policy'.padEnd(34)}${'pivots'.padEnd(8)}${'no-win'.padEnd(8)}${'replaced'.padEnd(14)}${'as map'.padEnd(14)}${'vs raw'.padEnd(20)}${'vs summarized'.padEnd(20)}degraded`,
  )
  for (const p of PIVOT_POLICIES) {
    const a = acc.get(p.label)!
    const vsRaw = a.replaced - a.map
    const vsSum = a.summarized - a.map
    console.log(
      `    ${p.label.padEnd(34)}${String(a.pivots).padEnd(8)}${String(a.gated).padEnd(8)}${a.replaced.toLocaleString().padEnd(14)}${a.map.toLocaleString().padEnd(14)}${`${vsRaw.toLocaleString()} (${pct(vsRaw, total)})`.padEnd(20)}${`${vsSum.toLocaleString()} (${pct(vsSum, total)})`.padEnd(20)}${a.degraded}`,
    )
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dirFlag = argv.indexOf('--dir')
  const dir = dirFlag >= 0 ? argv[dirFlag + 1]! : DEFAULT_DIR

  const samples = collect(dir)
  if (samples.length === 0) {
    console.error(`No Grep content-mode results found under ${dir}`)
    process.exit(1)
  }

  if (argv.includes('--pivot')) {
    await runPivot(samples, dir)
    return
  }

  let before = 0
  let after = 0
  let changed = 0
  let ctxBefore = 0
  let ctxAfter = 0
  let ctxChanged = 0
  let rawBefore = 0
  const ctxSamples = samples.filter(s => hasContext(s.input)).length

  for (const s of samples) {
    const text = normalize(s.text)
    const got = summarize(text)
    rawBefore += s.text.length
    before += text.length
    after += got.length
    if (got !== text) changed++
    if (hasContext(s.input)) {
      ctxBefore += text.length
      ctxAfter += got.length
      if (got !== text) ctxChanged++
    }
  }

  // Threshold curve. The dispatch gate is a module constant, so the curve is
  // computed from the strategy directly: for a candidate threshold T, a sample
  // is summarized when it is at least T chars AND the body actually shrinks
  // (the no-win guard, reproduced here as body.length < text.length).
  const curve = new Map<number, { saved: number; hits: number; eligible: number }>()
  for (const t of [3000, 4000, 6000, 8000]) {
    curve.set(t, { saved: 0, hits: 0, eligible: 0 })
  }
  // Policies, evaluated on the same samples. `lossy` counts the results whose
  // summary replaced at least one match line with a counter — the cost side of
  // lowering a threshold, which a chars-saved column alone hides.
  type Policy = {
    label: string
    admits: (len: number, elided: number) => boolean
    saved: number
    hits: number
    lossy: number
  }
  const policies: Policy[] = [
    {
      label: '>=6,000 only (before)',
      admits: len => len >= 6000,
      saved: 0,
      hits: 0,
      lossy: 0,
    },
    {
      label: '>=3,000, any summary',
      admits: len => len >= 3000,
      saved: 0,
      hits: 0,
      lossy: 0,
    },
    {
      label: '>=3,000 lossless, >=6,000 any',
      admits: (len, elided) => len >= 6000 || (len >= 3000 && elided === 0),
      saved: 0,
      hits: 0,
      lossy: 0,
    },
  ]
  for (const s of samples) {
    const text = normalize(s.text)
    const strategy = summarizeGrepOutput(text)
    for (const [t, acc] of curve) {
      if (text.length < t) continue
      acc.eligible++
      if (!strategy) continue
      // Envelope overhead is roughly 100 chars; approximate the guard with it.
      const kept = strategy.body.length + 100
      if (kept >= text.length) continue
      acc.hits++
      acc.saved += text.length - kept
    }
    if (!strategy) continue
    const keptBytes = strategy.body.length + 100
    if (keptBytes >= text.length) continue
    const elided = strategy.matchesElided ?? 0
    for (const p of policies) {
      if (!p.admits(text.length, elided)) continue
      p.hits++
      p.saved += text.length - keptBytes
      if (elided > 0) p.lossy++
    }
  }

  const rows = [
    ['results', String(samples.length)],
    ['  of which context-bearing', String(ctxSamples)],
    ['chars as recorded', rawBefore.toLocaleString()],
    ['path-fix saving', `${(rawBefore - before).toLocaleString()} (${pct(rawBefore - before, rawBefore)})`],
    ['chars before', before.toLocaleString()],
    ['chars after', after.toLocaleString()],
    ['saved', `${(before - after).toLocaleString()} (${pct(before - after, before)})`],
    ['results actually summarized', `${changed} (${pct(changed, samples.length)})`],
    ['context-bearing chars before', ctxBefore.toLocaleString()],
    ['context-bearing saved', `${(ctxBefore - ctxAfter).toLocaleString()} (${pct(ctxBefore - ctxAfter, ctxBefore)})`],
    ['context-bearing summarized', `${ctxChanged} of ${ctxSamples}`],
  ]

  if (argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          results: samples.length,
          before,
          after,
          saved: before - after,
          changed,
          ctxSamples,
          ctxBefore,
          ctxAfter,
          ctxChanged,
        },
        null,
        2,
      ),
    )
    return
  }

  console.log(`Grep summarizer replay — ${dir}`)
  for (const [k, v] of rows) console.log(`  ${k!.padEnd(30)} ${v}`)
  console.log('\n  threshold curve (strategy only, envelope approximated):')
  console.log(`    ${'T'.padEnd(8)}${'eligible'.padEnd(10)}${'summarized'.padEnd(12)}saved`)
  for (const [t, acc] of curve) {
    console.log(
      `    ${String(t).padEnd(8)}${String(acc.eligible).padEnd(10)}${String(acc.hits).padEnd(12)}${acc.saved.toLocaleString()} (${pct(acc.saved, before)})`,
    )
  }

  console.log('\n  dispatch policies (strategy only, envelope approximated):')
  console.log(
    `    ${'policy'.padEnd(32)}${'summarized'.padEnd(12)}${'saved'.padEnd(22)}lose a match`,
  )
  for (const p of policies) {
    console.log(
      `    ${p.label.padEnd(32)}${String(p.hits).padEnd(12)}${`${p.saved.toLocaleString()} (${pct(p.saved, before)})`.padEnd(22)}${p.lossy}`,
    )
  }
}

void main()
