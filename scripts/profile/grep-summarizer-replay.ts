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
 * Reports total chars saved, the split between context clamping / dedupe /
 * per-file capping, how many results stop tripping the no-win guard, and the
 * saving curve at candidate thresholds.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import {
  maybeSummarizeToolResult,
  summarizeGrepOutput,
} from '../../src/utils/toolResultSummarizer.js'
import { GREP_TOOL_NAME } from '../../src/tools/GrepTool/prompt.js'
import { relativizeRgLine } from '../../src/tools/GrepTool/relativize.js'

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
  const root = process.cwd()
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

function main(): void {
  const argv = process.argv.slice(2)
  const dirFlag = argv.indexOf('--dir')
  const dir = dirFlag >= 0 ? argv[dirFlag + 1]! : DEFAULT_DIR

  const samples = collect(dir)
  if (samples.length === 0) {
    console.error(`No Grep content-mode results found under ${dir}`)
    process.exit(1)
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
}

main()
