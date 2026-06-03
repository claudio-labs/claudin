/**
 * Measure the per-invocation token cost of skills (the body of a SKILL.md
 * loaded into the conversation when a slash-command/skill is fired).
 *
 * `measure-attachments-budget.ts` covers the `skill_listing` attachment
 * (the *catalogue* of available skills posted at session start). It does
 * NOT cover what actually happens when a user types `/foo` and the skill's
 * body gets injected — that's a separate, often much larger, cost.
 *
 * Real skills vary from ~1 KB (a thin slash-command stub) to ~50 KB+ (a
 * skill that bundles per-language docs, like `claude-api`). The model is
 * billed for the entire body on every invocation; first invocation is also
 * a guaranteed cache miss because the body is in user-message context, not
 * the cached system prefix.
 *
 * This bench does two things:
 *
 *   1. Synthetic profile: small/medium/large/huge bodies → reports bytes,
 *      tokens, and the system-reminder envelope overhead.
 *   2. Real best-effort: registers the bundled skills that don't depend on
 *      build-time `.md` imports (debug, loop, keybindings, code-review) and
 *      asks them to produce a prompt with empty args. Reports the true
 *      bytes per skill.
 *
 * Read-only. No model calls. No actual command dispatch.
 *
 * Flags:
 *   --invocations-per-session=3   how many skill fires/session (default 3)
 *   --model=<name>                tokenizer ratio (default claude-sonnet-4-5)
 *   --json                        machine-readable
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

type Profile = 'small' | 'medium' | 'large' | 'huge'

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

const PROFILE_BYTES: Record<Profile, number> = {
  small: 1_500,
  medium: 6_000,
  large: 24_000,
  huge: 80_000,
}

export type SyntheticRow = {
  profile: Profile
  bodyBytes: number
  tokens: number
}

export type RealSkillRow = {
  skillName: string
  source: string
  promptBytes: number
  promptTokens: number
  errored?: string
}

export type SkillInvocationResult = {
  model: string
  bytesPerToken: number
  invocationsPerSession: number
  synthetic: SyntheticRow[]
  realSkills: RealSkillRow[]
  /** Tokens spent if a session invokes `invocationsPerSession` medium skills */
  perSessionMediumTokens: number
}

async function loadRealBundledSkills(): Promise<RealSkillRow[]> {
  const rows: RealSkillRow[] = []

  let bundledSkillsApi: typeof import('../src/skills/bundledSkills.js') | null
  try {
    bundledSkillsApi = await import('../src/skills/bundledSkills.js')
    bundledSkillsApi.clearBundledSkills()
  } catch (err) {
    return [
      {
        skillName: '<bundledSkills>',
        source: 'bundled',
        promptBytes: 0,
        promptTokens: 0,
        errored: err instanceof Error ? err.message : String(err),
      },
    ]
  }

  // Walk register functions for every bundled skill that's safe to load
  // synchronously. Production `initBundledSkills()` registers more, but
  // some have side effects at module-eval / register time:
  //   - `scheduleRemoteAgents` calls `fetchEnvironments` (network).
  //   - `claudeInChrome` depends on `@ant/claude-for-chrome-mcp` (stubbed
  //     in this build), but registers an isEnabled callback we don't want
  //     to evaluate.
  //   - `claudeApi` imports per-language `.md` files via Bun text loader
  //     which only resolves during `bun run build`, not under `bun test`.
  // The 6 we DO load here cover every interactive bundled skill that has
  // no .md import or network side effect. That's strictly more than the
  // 3 the previous version of this bench loaded.
  const registrars: { name: string; load: () => Promise<unknown> }[] = [
    { name: 'updateConfig', load: () => import('../src/skills/bundled/updateConfig.js') },
    { name: 'keybindings', load: () => import('../src/skills/bundled/keybindings.js') },
    { name: 'debug', load: () => import('../src/skills/bundled/debug.js') },
    { name: 'code-review', load: () => import('../src/skills/bundled/code-review.js') },
    { name: 'batch', load: () => import('../src/skills/bundled/batch.js') },
    { name: 'loop', load: () => import('../src/skills/bundled/loop.js') },
  ]

  for (const r of registrars) {
    try {
      const mod = (await r.load()) as Record<string, unknown>
      // Find the first exported function whose name starts with `register`.
      const fn = Object.values(mod).find(
        v => typeof v === 'function' && (v as Function).name.startsWith('register'),
      ) as (() => void) | undefined
      if (typeof fn !== 'function') {
        // Module is content-only (e.g. claudeApiContent, verifyContent) — skip.
        continue
      }
      fn()
    } catch (err) {
      rows.push({
        skillName: r.name,
        source: 'bundled',
        promptBytes: 0,
        promptTokens: 0,
        errored: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const skills = bundledSkillsApi.getBundledSkills()
  for (const skill of skills) {
    try {
      // Synthesize an empty-args invocation. We pass a stub ToolUseContext
      // — most bundled skill bodies don't read the context, but a few may.
      // biome-ignore lint/suspicious/noExplicitAny: synthetic ctx
      const ctx: any = { options: { commands: [], agentDefinitions: { activeAgents: [] }, mcpClients: [] } }
      const blocks = await (skill as unknown as { getPromptForCommand: (a: string, c: unknown) => Promise<{ type: string; text?: string }[]> }).getPromptForCommand('', ctx)
      const text = blocks
        .map(b => (b.type === 'text' ? b.text ?? '' : JSON.stringify(b)))
        .join('\n')
      rows.push({
        skillName: skill.name,
        source: (skill as { source?: string }).source ?? 'bundled',
        promptBytes: bytes(text),
        promptTokens: roughTokenCountEstimation(text),
      })
    } catch (err) {
      rows.push({
        skillName: skill.name,
        source: (skill as { source?: string }).source ?? 'bundled',
        promptBytes: 0,
        promptTokens: 0,
        errored: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return rows
}

export async function measureSkillInvocationCost(options: {
  invocationsPerSession?: number
  model?: string
} = {}): Promise<SkillInvocationResult> {
  const invocationsPerSession = options.invocationsPerSession ?? 3
  const model = options.model ?? 'claude-sonnet-4-5'

  try {
    enableConfigs()
  } catch {
    // best-effort
  }

  const ratio = getBytesPerTokenForModel(model)

  const synthetic: SyntheticRow[] = (
    ['small', 'medium', 'large', 'huge'] as Profile[]
  ).map(profile => {
    const body = bodyOfSize(PROFILE_BYTES[profile])
    return {
      profile,
      bodyBytes: bytes(body),
      tokens: roughTokenCountEstimation(body, ratio),
    }
  })

  const realSkills = await loadRealBundledSkills()
  realSkills.sort((a, b) => b.promptTokens - a.promptTokens)

  const mediumTokens =
    synthetic.find(s => s.profile === 'medium')?.tokens ?? 0
  const perSessionMediumTokens = mediumTokens * invocationsPerSession

  return {
    model,
    bytesPerToken: ratio,
    invocationsPerSession,
    synthetic,
    realSkills,
    perSessionMediumTokens,
  }
}

function formatTable(result: SkillInvocationResult): string {
  const lines: string[] = []
  lines.push(
    `# Skill invocation cost — model=${result.model} (bytes/token=${result.bytesPerToken}) invocations/session=${result.invocationsPerSession}`,
  )
  lines.push('')
  lines.push('## Synthetic profiles')
  const synthHeaders = ['profile', 'bytes', 'tokens']
  const synthData = result.synthetic.map(r => [
    r.profile,
    r.bodyBytes.toLocaleString('en-US'),
    r.tokens.toLocaleString('en-US'),
  ])
  const synthW = synthHeaders.map((h, i) =>
    Math.max(h.length, ...synthData.map(row => row[i]!.length)),
  )
  const synthFmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(synthW[i]!)).join('  ')
  lines.push(synthFmt(synthHeaders))
  lines.push(synthW.map(w => '-'.repeat(w)).join('  '))
  for (const row of synthData) lines.push(synthFmt(row))

  lines.push('')
  lines.push('## Real bundled skills (best-effort)')
  if (result.realSkills.length === 0) {
    lines.push('  (none registered)')
  } else {
    const realHeaders = ['skill', 'source', 'bytes', 'tokens', 'note']
    const realData = result.realSkills.map(r => [
      r.skillName,
      r.source,
      r.promptBytes.toLocaleString('en-US'),
      r.promptTokens.toLocaleString('en-US'),
      r.errored ?? '',
    ])
    const realW = realHeaders.map((h, i) =>
      Math.max(h.length, ...realData.map(row => row[i]!.length)),
    )
    const realFmt = (row: string[]) =>
      row.map((c, i) => c.padEnd(realW[i]!)).join('  ')
    lines.push(realFmt(realHeaders))
    lines.push(realW.map(w => '-'.repeat(w)).join('  '))
    for (const row of realData) lines.push(realFmt(row))
  }

  lines.push('')
  lines.push(
    `Per-session @ medium profile × ${result.invocationsPerSession} invocations: ${result.perSessionMediumTokens.toLocaleString('en-US')} tokens`,
  )
  return lines.join('\n')
}

function parseArgs(argv: readonly string[]): {
  invocationsPerSession: number
  model: string
  asJson: boolean
} {
  let invocationsPerSession = 3
  let model = 'claude-sonnet-4-5'
  let asJson = false
  for (const arg of argv) {
    if (arg === '--json') asJson = true
    else if (arg.startsWith('--invocations-per-session='))
      invocationsPerSession = Number(arg.slice('--invocations-per-session='.length))
    else if (arg.startsWith('--model=')) model = arg.slice('--model='.length)
  }
  return { invocationsPerSession, model, asJson }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await measureSkillInvocationCost(opts)
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
