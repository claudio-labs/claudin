/**
 * Measure the per-turn token cost of LSP diagnostic injection.
 *
 * The diagnostics attachment (`getLSPDiagnosticAttachments`) eventually
 * renders through `DiagnosticTrackingService.formatDiagnosticsSummary` and
 * gets wrapped in a `<new-diagnostics>` system-reminder. The formatter has
 * a 4000-char hard truncation cap (`MAX_DIAGNOSTICS_SUMMARY_CHARS`), but:
 *
 *   - the wrapping system-reminder text adds ~80 bytes on top of that;
 *   - typescript / eslint diagnostics are often longer than rust/go ones,
 *     so the same #files can yield very different bytes;
 *   - if many diagnostics get truncated we *lose information* (silent
 *     ellipsis), which is itself a knob worth surfacing.
 *
 * This bench drives the production formatter with synthetic
 * `DiagnosticFile[]` fixtures across realistic ranges, measures the
 * post-wrap bytes/tokens, and flags when the truncation cap kicked in.
 *
 * Flags:
 *   --files=N             how many files have diagnostics (default 5)
 *   --diags-per-file=N    diagnostics per file (default 4)
 *   --message-bytes=N     per-diagnostic message length in bytes (default 80)
 *   --variants=ts,go,rust comma-separated profile names mixing typical
 *                          per-language message verbosity (default ts,go,rust,eslint)
 *   --model=<name>        tokenizer ratio (default claude-sonnet-4-5)
 *   --json                machine-readable
 *
 * Read-only. No actual LSP server is started.
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

import { DiagnosticTrackingService } from '../../../src/platform/diagnosticTracking.js'
import type {
  Diagnostic,
  DiagnosticFile,
} from '../../../src/platform/diagnosticTracking.js'
import {
  getBytesPerTokenForModel,
  roughTokenCountEstimation,
} from '../../../src/shared/tokenEstimation.js'
import { enableConfigs } from '../../../src/platform/config/config.js'

// Hard cap inside formatDiagnosticsSummary. We don't import the constant
// because it's not exported — we mirror its value here so the bench can
// surface "truncated" rows. Keep in sync with diagnosticTracking.ts:12.
const MAX_DIAGNOSTICS_SUMMARY_CHARS = 4000

const LANGUAGE_PROFILES: Record<string, { source: string; avgMsgBytes: number }> = {
  ts: { source: 'tsserver', avgMsgBytes: 140 },
  eslint: { source: 'eslint', avgMsgBytes: 110 },
  rust: { source: 'rust-analyzer', avgMsgBytes: 70 },
  go: { source: 'gopls', avgMsgBytes: 60 },
  python: { source: 'pyright', avgMsgBytes: 90 },
}

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

function makeDiagnostic(opts: {
  line: number
  column: number
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  source: string
  messageBytes: number
}): Diagnostic {
  return {
    severity: opts.severity,
    message: `${opts.severity}: ${bodyOfSize(opts.messageBytes)}`,
    range: {
      start: { line: opts.line, character: opts.column },
      end: { line: opts.line, character: opts.column + 10 },
    },
    source: opts.source,
    code: 'TS2304',
  }
}

function makeFiles(opts: {
  files: number
  diagsPerFile: number
  source: string
  messageBytes: number
  ext: string
}): DiagnosticFile[] {
  const out: DiagnosticFile[] = []
  for (let i = 0; i < opts.files; i++) {
    const diags = Array.from({ length: opts.diagsPerFile }, (_, j) =>
      makeDiagnostic({
        line: 10 + j,
        column: 1,
        severity: j % 3 === 0 ? 'Error' : 'Warning',
        source: opts.source,
        messageBytes: opts.messageBytes,
      }),
    )
    out.push({
      uri: `file:///tmp/example/file${i}.${opts.ext}`,
      diagnostics: diags,
    })
  }
  return out
}

export type LspRow = {
  variant: string
  files: number
  diagsPerFile: number
  rawBytes: number
  rawTokens: number
  /** After-truncation bytes returned by formatDiagnosticsSummary */
  formattedBytes: number
  formattedTokens: number
  /** Plus the <new-diagnostics> system-reminder wrapper */
  wireBytes: number
  wireTokens: number
  truncated: boolean
  /** Bytes lost to the 4 KB cap (rawBytes − formattedBytes when truncated) */
  bytesLostToTruncation: number
}

export type LspBudgetResult = {
  model: string
  bytesPerToken: number
  rows: LspRow[]
  totalWireBytes: number
  totalWireTokens: number
}

const VARIANT_EXTS: Record<string, string> = {
  ts: 'ts',
  eslint: 'tsx',
  rust: 'rs',
  go: 'go',
  python: 'py',
}

function wrapForWire(formatted: string): string {
  // Mirror the wrapping done in `messages.ts` `case 'diagnostics'`.
  return `<new-diagnostics>The following new diagnostic issues were detected:\n\n${formatted}</new-diagnostics>`
}

export async function measureLspDiagnosticBudget(options: {
  files?: number
  diagsPerFile?: number
  messageBytes?: number
  variants?: readonly string[]
  model?: string
} = {}): Promise<LspBudgetResult> {
  const files = options.files ?? 5
  const diagsPerFile = options.diagsPerFile ?? 4
  const messageBytesOverride = options.messageBytes
  const variants = options.variants ?? ['ts', 'eslint', 'rust', 'go', 'python']
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const rows: LspRow[] = []

  for (const variant of variants) {
    const profile = LANGUAGE_PROFILES[variant]
    if (!profile) continue
    const messageBytes = messageBytesOverride ?? profile.avgMsgBytes
    const ext = VARIANT_EXTS[variant] ?? 'txt'

    const fileSet = makeFiles({
      files,
      diagsPerFile,
      source: profile.source,
      messageBytes,
      ext,
    })

    // Compute the un-truncated formatter output by running the formatter on
    // chunks small enough that the cap can't fire — we rebuild the same
    // bytes the formatter would have produced if the cap were absent.
    const rawSummary = fileSet
      .map(f => {
        const filename = f.uri.split('/').pop() ?? f.uri
        const lines = f.diagnostics
          .map(
            d =>
              `  ${d.severity === 'Error' ? '❌' : '⚠'} [Line ${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}${d.code ? ` [${d.code}]` : ''}${d.source ? ` (${d.source})` : ''}`,
          )
          .join('\n')
        return `${filename}:\n${lines}`
      })
      .join('\n\n')
    const rawBytes = Buffer.byteLength(rawSummary, 'utf8')

    const formatted = DiagnosticTrackingService.formatDiagnosticsSummary(fileSet)
    const formattedBytes = Buffer.byteLength(formatted, 'utf8')
    // Detect both the legacy plain marker and the current honest footer
    // ("…[truncated: N more diagnostics across M files — …]"). Either form
    // means the cap kicked in.
    const truncated = formatted.includes('…[truncated')

    const wire = wrapForWire(formatted)
    const wireBytes = Buffer.byteLength(wire, 'utf8')

    rows.push({
      variant,
      files,
      diagsPerFile,
      rawBytes,
      rawTokens: roughTokenCountEstimation(rawSummary, ratio),
      formattedBytes,
      formattedTokens: roughTokenCountEstimation(formatted, ratio),
      wireBytes,
      wireTokens: roughTokenCountEstimation(wire, ratio),
      truncated,
      bytesLostToTruncation: truncated ? Math.max(0, rawBytes - formattedBytes) : 0,
    })
  }

  let totalWireBytes = 0
  let totalWireTokens = 0
  for (const r of rows) {
    totalWireBytes += r.wireBytes
    totalWireTokens += r.wireTokens
  }

  return { model, bytesPerToken: ratio, rows, totalWireBytes, totalWireTokens }
}

function formatTable(result: LspBudgetResult): string {
  const lines: string[] = []
  lines.push(
    `# LSP diagnostic budget — model=${result.model} (bytes/token=${result.bytesPerToken}) cap=${MAX_DIAGNOSTICS_SUMMARY_CHARS}c`,
  )
  lines.push('')
  const headers = [
    'language',
    'files',
    'diags/file',
    'raw (B)',
    'wire (B)',
    'wire (tok)',
    'truncated?',
    'lost (B)',
  ]
  const data = result.rows.map(r => [
    r.variant,
    String(r.files),
    String(r.diagsPerFile),
    r.rawBytes.toLocaleString('en-US'),
    r.wireBytes.toLocaleString('en-US'),
    r.wireTokens.toLocaleString('en-US'),
    r.truncated ? 'yes' : 'no',
    r.bytesLostToTruncation.toLocaleString('en-US'),
  ])
  data.push([
    'TOTAL',
    '',
    '',
    '',
    result.totalWireBytes.toLocaleString('en-US'),
    result.totalWireTokens.toLocaleString('en-US'),
    '',
    '',
  ])
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i]!.length)),
  )
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  lines.push(fmt(headers))
  lines.push(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of data) lines.push(fmt(row))
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  files: number
  diagsPerFile: number
  messageBytes: number | undefined
  variants: readonly string[]
  model: string
  asJson: boolean
} {
  let files = 5
  let diagsPerFile = 4
  let messageBytes: number | undefined
  let variants: string[] = ['ts', 'eslint', 'rust', 'go', 'python']
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--files=')) files = Number(arg.slice('--files='.length))
    else if (arg.startsWith('--diags-per-file='))
      diagsPerFile = Number(arg.slice('--diags-per-file='.length))
    else if (arg.startsWith('--message-bytes='))
      messageBytes = Number(arg.slice('--message-bytes='.length))
    else if (arg.startsWith('--variants=')) {
      variants = arg.slice('--variants='.length).split(',').filter(Boolean)
    } else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { files, diagsPerFile, messageBytes, variants, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureLspDiagnosticBudget(opts)
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
