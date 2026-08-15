/**
 * Compare per-call token cost: WebFetch / WebSearch across the real
 * production paths.
 *
 * Earlier versions of this bench assumed the default (non-Firecrawl) path
 * returned stripped HTML, ~25% more verbose than Firecrawl markdown. That
 * was wrong. Both paths in `WebFetchTool.ts:218-339` actually pipe through
 * `applyPromptToMarkdown` (a Haiku summary call) before returning, so the
 * tool_result is bounded by Haiku's own output length (~500-2k tokens),
 * regardless of which extractor produced the upstream markdown.
 *
 * The interesting cost divergence is the **preapproved-markdown
 * shortcut** (`WebFetchTool.ts:297-302`): for whitelisted domains
 * returning `text/markdown` smaller than `MAX_MARKDOWN_LENGTH=100,000`
 * chars, the tool short-circuits and returns the raw markdown DIRECTLY —
 * up to ~28k tokens — instead of a Haiku summary. That's the path users
 * pay heavily for when they fetch e.g. raw documentation pages.
 *
 * What this bench reports:
 *
 *   - Haiku-summary path (both Firecrawl and default fall here for most
 *     URLs) — bounded by the model's response budget.
 *   - Preapproved-markdown shortcut (default path only) — raw content up
 *     to MAX_MARKDOWN_LENGTH.
 *   - WebSearch envelope is identical between providers (only hit count
 *     differs slightly), so it's still measured here for completeness.
 *
 * Read-only. No real fetches. No network.
 *
 * Flags:
 *   --searches-per-session=2    (default 2)
 *   --fetches-per-session=2     (default 2)
 *   --preapproved-fetch-rate=0.2  fraction of fetches that hit the
 *                                  preapproved-markdown shortcut (default 0.2)
 *   --model=<name>              tokenizer ratio (default claude-sonnet-4-5)
 *   --json                      machine-readable
 */

if (typeof (globalThis as { MACRO?: unknown }).MACRO === 'undefined') {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '99.0.0',
      DISPLAY_VERSION: '0.0.0-measure',
      BUILD_TIME: new Date().toISOString(),
      ISSUES_EXPLAINER:
        'report the issue at https://github.com/anthropics/claude-code/issues',
      PACKAGE_URL: '@claudiolabs/claudin',
    },
  })
}

import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../src/services/tokenEstimation.js'
import { enableConfigs } from '../src/platform/config/config.js'
import { MAX_MARKDOWN_LENGTH } from '../src/tools/WebFetchTool/utils.js'

type Profile = 'small' | 'typical' | 'large'

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n'

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

/** Haiku output sizes — observed empirically to land in 1-3 KB for typical
 *  prompts ("summarize this page", "find X in the article"). The summary
 *  size doesn't scale with input length once Haiku is invoked: it's a
 *  function of Haiku's response length budget, not the source page. */
const HAIKU_SUMMARY_BYTES: Record<Profile, number> = {
  small: 800,
  typical: 1_800,
  large: 3_500,
}

/** Preapproved-markdown bypass returns the raw markdown body up to
 *  MAX_MARKDOWN_LENGTH (100 KB). Real distribution: docs pages cluster
 *  around 5-30 KB, with long ones approaching the cap. */
const PREAPPROVED_MARKDOWN_BYTES: Record<Profile, number> = {
  small: 5_000,
  typical: 25_000,
  large: MAX_MARKDOWN_LENGTH, // hits the 100 KB cap
}

const SEARCH_HIT_COUNTS: Record<Profile, number> = {
  small: 3,
  typical: 10,
  large: 25,
}

function renderSearchEnvelope(hitCount: number, descBytes: number): string {
  const hits = Array.from({ length: hitCount }, (_, i) => ({
    title: `Result ${i + 1}: example.com`,
    url: `https://example.com/page-${i + 1}`,
    description: bodyOfSize(descBytes),
  }))
  return JSON.stringify({ hits, query: 'sample query' })
}

function renderHaikuSummary(profile: Profile): string {
  // Haiku's typical wrapper text plus the body it returned.
  return [
    'Based on the content of the page, here are the key points:',
    '',
    bodyOfSize(HAIKU_SUMMARY_BYTES[profile]),
  ].join('\n')
}

function renderPreapprovedMarkdown(profile: Profile): string {
  return [
    '# Documentation Page',
    '',
    bodyOfSize(PREAPPROVED_MARKDOWN_BYTES[profile]),
  ].join('\n')
}

export type WebRow = {
  path: 'firecrawl-haiku' | 'default-haiku' | 'default-preapproved'
  operation: 'search' | 'fetch'
  profile: Profile
  bytes: number
  tokens: number
}

export type WebFetchEnvelopeResult = {
  model: string
  bytesPerToken: number
  searchesPerSession: number
  fetchesPerSession: number
  preapprovedFetchRate: number
  rows: WebRow[]
  /** Per-session estimate: typical search + a mix of haiku/preapproved fetches. */
  sessionTokens: number
  /** Same session if every fetch took the preapproved-markdown shortcut. */
  sessionTokensWorstCase: number
}

export async function measureWebFetchEnvelope(options: {
  searchesPerSession?: number
  fetchesPerSession?: number
  preapprovedFetchRate?: number
  model?: string
} = {}): Promise<WebFetchEnvelopeResult> {
  const searchesPerSession = options.searchesPerSession ?? 2
  const fetchesPerSession = options.fetchesPerSession ?? 2
  const preapprovedFetchRate = options.preapprovedFetchRate ?? 0.2
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  const rows: WebRow[] = []
  for (const profile of ['small', 'typical', 'large'] as Profile[]) {
    // Search rows — identical envelope shape across providers.
    const search = renderSearchEnvelope(SEARCH_HIT_COUNTS[profile], 200)
    rows.push({
      path: 'firecrawl-haiku',
      operation: 'search',
      profile,
      bytes: bytes(search),
      tokens: roughTokenCountEstimation(search, ratio),
    })
    rows.push({
      path: 'default-haiku',
      operation: 'search',
      profile,
      bytes: bytes(search),
      tokens: roughTokenCountEstimation(search, ratio),
    })

    // Fetch — Haiku-summary path (both Firecrawl and default).
    const haiku = renderHaikuSummary(profile)
    rows.push({
      path: 'firecrawl-haiku',
      operation: 'fetch',
      profile,
      bytes: bytes(haiku),
      tokens: roughTokenCountEstimation(haiku, ratio),
    })
    rows.push({
      path: 'default-haiku',
      operation: 'fetch',
      profile,
      bytes: bytes(haiku),
      tokens: roughTokenCountEstimation(haiku, ratio),
    })

    // Fetch — default's preapproved-markdown shortcut (returns raw body).
    const raw = renderPreapprovedMarkdown(profile)
    rows.push({
      path: 'default-preapproved',
      operation: 'fetch',
      profile,
      bytes: bytes(raw),
      tokens: roughTokenCountEstimation(raw, ratio),
    })
  }

  // Session projections: typical-profile values.
  const typical = (path: WebRow['path'], op: WebRow['operation']) =>
    rows.find(r => r.path === path && r.operation === op && r.profile === 'typical')!.tokens

  const searchTokens = typical('default-haiku', 'search')
  const haikuFetchTokens = typical('default-haiku', 'fetch')
  const preapprovedFetchTokens = typical('default-preapproved', 'fetch')

  // Mixed: `preapprovedFetchRate` fraction of fetches take the shortcut.
  const haikuFetches = fetchesPerSession * (1 - preapprovedFetchRate)
  const preapprovedFetches = fetchesPerSession * preapprovedFetchRate
  const sessionTokens = Math.round(
    searchTokens * searchesPerSession +
      haikuFetchTokens * haikuFetches +
      preapprovedFetchTokens * preapprovedFetches,
  )

  // Worst case: every fetch hits the preapproved shortcut.
  const sessionTokensWorstCase =
    searchTokens * searchesPerSession +
    preapprovedFetchTokens * fetchesPerSession

  return {
    model,
    bytesPerToken: ratio,
    searchesPerSession,
    fetchesPerSession,
    preapprovedFetchRate,
    rows,
    sessionTokens,
    sessionTokensWorstCase,
  }
}

function formatTable(result: WebFetchEnvelopeResult): string {
  const lines: string[] = []
  lines.push(
    `# WebFetch / WebSearch envelope — model=${result.model} (bytes/token=${result.bytesPerToken})`,
  )
  lines.push('')
  const headers = ['operation', 'profile', 'firecrawl-haiku', 'default-haiku', 'default-preapproved']
  const profiles = ['small', 'typical', 'large'] as Profile[]
  const operations = ['search', 'fetch'] as const
  const data: string[][] = []
  for (const op of operations) {
    for (const profile of profiles) {
      const fc = result.rows.find(
        r => r.path === 'firecrawl-haiku' && r.operation === op && r.profile === profile,
      )
      const dh = result.rows.find(
        r => r.path === 'default-haiku' && r.operation === op && r.profile === profile,
      )
      const dp = result.rows.find(
        r => r.path === 'default-preapproved' && r.operation === op && r.profile === profile,
      )
      data.push([
        op,
        profile,
        fc?.tokens.toLocaleString('en-US') ?? '—',
        dh?.tokens.toLocaleString('en-US') ?? '—',
        dp?.tokens.toLocaleString('en-US') ?? '—',
      ])
    }
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  lines.push(fmt(headers))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of data) lines.push(fmt(row))
  lines.push('')
  lines.push(
    `Per-session estimate (${result.searchesPerSession} search + ${result.fetchesPerSession} fetch @ typical, preapproved rate=${result.preapprovedFetchRate}):`,
  )
  lines.push(`  Mixed: ${result.sessionTokens.toLocaleString('en-US')} tokens`)
  lines.push(
    `  Worst case (all preapproved): ${result.sessionTokensWorstCase.toLocaleString('en-US')} tokens`,
  )
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  searchesPerSession: number
  fetchesPerSession: number
  preapprovedFetchRate: number
  model: string
  asJson: boolean
} {
  let searchesPerSession = 2
  let fetchesPerSession = 2
  let preapprovedFetchRate = 0.2
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--searches-per-session='))
      searchesPerSession = Number(arg.slice('--searches-per-session='.length))
    else if (arg.startsWith('--fetches-per-session='))
      fetchesPerSession = Number(arg.slice('--fetches-per-session='.length))
    else if (arg.startsWith('--preapproved-fetch-rate='))
      preapprovedFetchRate = Number(arg.slice('--preapproved-fetch-rate='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return {
    searchesPerSession,
    fetchesPerSession,
    preapprovedFetchRate,
    model,
    asJson,
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureWebFetchEnvelope(opts)
  if (opts.asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${formatTable(result)}\n`)
}

const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  try {
    return import.meta.url === new URL(process.argv[1], 'file://').href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
