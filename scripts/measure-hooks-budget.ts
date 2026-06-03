/**
 * Measure the per-turn token cost of user-defined hooks injecting context.
 *
 * Hooks live in `~/.claude/settings.json` and fire on events
 * (UserPromptSubmit, SessionStart, PreToolUse, PostToolUse, ...). On
 * "success" events that are SessionStart or UserPromptSubmit, hook stdout
 * is wrapped in a `<system-reminder>` and injected as a user message.
 * `hook_additional_context` does the same with a list of strings.
 *
 * Hooks are invisible in the existing benches: `measure-attachments-budget`
 * doesn't include any hook_* attachment types, and there's no aggregate
 * "what does my hook config cost per turn" view. This bench fills that
 * gap by walking each hook attachment type, simulating realistic content
 * sizes (small/medium/large), and reporting:
 *
 *   - bytes / tokens of one fired hook injection
 *   - estimated cost across N hooks per turn × M turns
 *   - the system-reminder envelope overhead
 *
 * Read-only. No real hooks are executed; we render the same shape as
 * production via `wrapInSystemReminder`.
 *
 * Flags:
 *   --hooks-per-turn=2     average #hooks firing per turn (default 2)
 *   --turns=20             projection horizon (default 20)
 *   --model=<name>         tokenizer ratio (default claude-sonnet-4-5)
 *   --json                 machine-readable
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
import { enableConfigs } from '../src/utils/config.js'
import { wrapInSystemReminder } from '../src/utils/messages.js'

type Profile = 'small' | 'typical' | 'large'

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function bodyOfSize(targetBytes: number): string {
  if (targetBytes <= 0) return ''
  const repeats = Math.ceil(targetBytes / LOREM.length)
  return LOREM.repeat(repeats).slice(0, targetBytes)
}

const PROFILE_BYTES: Record<Profile, number> = {
  small: 80,
  typical: 400,
  large: 2000,
}

function renderHookSuccessUserPromptSubmit(
  hookName: string,
  profile: Profile,
): string {
  const body = bodyOfSize(PROFILE_BYTES[profile])
  return wrapInSystemReminder(`${hookName} hook success: ${body}`)
}

function renderHookAdditionalContext(
  hookName: string,
  profile: Profile,
  itemCount: number,
): string {
  const itemSize = Math.floor(PROFILE_BYTES[profile] / itemCount)
  const items = Array.from({ length: itemCount }, () => bodyOfSize(itemSize))
  return wrapInSystemReminder(
    `${hookName} hook additional context: ${items.join('\n')}`,
  )
}

function renderHookBlockingError(hookName: string, profile: Profile): string {
  const body = bodyOfSize(PROFILE_BYTES[profile])
  return wrapInSystemReminder(
    `${hookName} hook blocking error from command: "/path/to/hook --flag": ${body}`,
  )
}

function renderHookStoppedContinuation(
  hookName: string,
  profile: Profile,
): string {
  const body = bodyOfSize(PROFILE_BYTES[profile])
  return wrapInSystemReminder(
    `${hookName} hook stopped continuation: ${body}`,
  )
}

function renderHookNonBlockingError(
  hookName: string,
  profile: Profile,
): string {
  // Non-blocking errors render through formatHookError → also a
  // system-reminder, but with `stderr` + `stdout` lines. Approximate the
  // production shape rather than importing the formatter.
  return wrapInSystemReminder(
    `${hookName} hook returned a non-blocking error\nstderr: parse failed\nstdout: ${bodyOfSize(PROFILE_BYTES[profile])}`,
  )
}

const HOOK_TYPES = [
  {
    type: 'hook_success_UserPromptSubmit',
    render: renderHookSuccessUserPromptSubmit,
    needsItems: false,
  },
  {
    type: 'hook_additional_context_2items',
    render: (hn: string, p: Profile) => renderHookAdditionalContext(hn, p, 2),
    needsItems: true,
  },
  {
    type: 'hook_additional_context_5items',
    render: (hn: string, p: Profile) => renderHookAdditionalContext(hn, p, 5),
    needsItems: true,
  },
  {
    type: 'hook_blocking_error',
    render: renderHookBlockingError,
    needsItems: false,
  },
  {
    type: 'hook_stopped_continuation',
    render: renderHookStoppedContinuation,
    needsItems: false,
  },
  {
    type: 'hook_non_blocking_error',
    render: renderHookNonBlockingError,
    needsItems: false,
  },
] as const

export type HookRow = {
  hookType: string
  profile: Profile
  bytes: number
  tokens: number
  /** Bytes added by `<system-reminder>` envelope */
  envelopeOverheadBytes: number
}

export type HooksBudgetResult = {
  model: string
  bytesPerToken: number
  hooksPerTurn: number
  turns: number
  rows: HookRow[]
  /** Tokens accumulated per-turn assuming hooksPerTurn fires of "typical" size. */
  perTurnTokensTypical: number
  /** Tokens projected across `turns` */
  projectedTokens: number
}

function envelopeBytes(): number {
  return bytes(wrapInSystemReminder('')) - 0 // 30 bytes
}

export async function measureHooksBudget(options: {
  hooksPerTurn?: number
  turns?: number
  model?: string
} = {}): Promise<HooksBudgetResult> {
  const hooksPerTurn = options.hooksPerTurn ?? 2
  const turns = options.turns ?? 20
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)
  const overhead = envelopeBytes()

  const rows: HookRow[] = []
  for (const profile of ['small', 'typical', 'large'] as const) {
    for (const def of HOOK_TYPES) {
      const wire = def.render('myHook', profile)
      rows.push({
        hookType: def.type,
        profile,
        bytes: bytes(wire),
        tokens: roughTokenCountEstimation(wire, ratio),
        envelopeOverheadBytes: overhead,
      })
    }
  }

  rows.sort((a, b) => {
    if (a.profile !== b.profile) {
      const order = ['small', 'typical', 'large']
      return order.indexOf(a.profile) - order.indexOf(b.profile)
    }
    return b.tokens - a.tokens
  })

  // Projection: pick a "typical" representative cost (UserPromptSubmit
  // success at typical size — the most common hook in real configs).
  const typicalTokens =
    rows.find(
      r =>
        r.profile === 'typical' &&
        r.hookType === 'hook_success_UserPromptSubmit',
    )?.tokens ?? 0
  const perTurnTokensTypical = typicalTokens * hooksPerTurn
  const projectedTokens = perTurnTokensTypical * turns

  return {
    model,
    bytesPerToken: ratio,
    hooksPerTurn,
    turns,
    rows,
    perTurnTokensTypical,
    projectedTokens,
  }
}

function formatTable(result: HooksBudgetResult): string {
  const lines: string[] = []
  lines.push(
    `# Hooks budget — model=${result.model} (bytes/token=${result.bytesPerToken}) hooks/turn=${result.hooksPerTurn} turns=${result.turns}`,
  )
  lines.push('')
  const headers = ['profile', 'hookType', 'bytes', 'tokens', 'envelope (B)']
  const data = result.rows.map(r => [
    r.profile,
    r.hookType,
    r.bytes.toLocaleString('en-US'),
    r.tokens.toLocaleString('en-US'),
    r.envelopeOverheadBytes.toLocaleString('en-US'),
  ])
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
    `Per-turn (typical): ${result.perTurnTokensTypical.toLocaleString('en-US')} tokens`,
  )
  lines.push(
    `Projected over ${result.turns} turns: ${result.projectedTokens.toLocaleString('en-US')} tokens`,
  )
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  hooksPerTurn: number
  turns: number
  model: string
  asJson: boolean
} {
  let hooksPerTurn = 2
  let turns = 20
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--hooks-per-turn='))
      hooksPerTurn = Number(arg.slice('--hooks-per-turn='.length))
    else if (arg.startsWith('--turns=')) turns = Number(arg.slice('--turns='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { hooksPerTurn, turns, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureHooksBudget(opts)
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
