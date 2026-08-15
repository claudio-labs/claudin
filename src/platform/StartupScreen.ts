/**
 * Claudin startup screen — compact pixel-art logo + provider/cwd lines.
 * Called once at CLI startup before the Ink UI renders.
 */

import os from 'os'

import { readLatestVersion } from 'src/platform/install/latestVersionCache.js'
import { gt } from 'src/shared/semver.js'
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { isLocalProviderUrl, resolveProviderRequest } from 'src/services/api/providerConfig.js'
import { getLocalOpenAICompatibleProviderLabel } from 'src/services/api/providerDiscovery.js'
import { parseUserSpecifiedModel } from 'src/utils/model/model.js'
import { getDisplayedEffortLabel, getInitialEffortSetting, modelSupportsEffort, type AdaptiveEffort, type EffortLevel } from 'src/utils/effort.js'
import { effortLevelToSymbol } from 'src/components/EffortIndicator.js'

const UNCONFIGURED_PLACEHOLDER = '—'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`
const BOLD = `${ESC}1m`
const GREEN = `${ESC}32m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`

// ─── Colors ───────────────────────────────────────────────────────────────────

const PINK_LIGHT: RGB = [243, 145, 175]
const PINK: RGB = [225, 95, 140]
const PINK_DARK: RGB = [170, 65, 110]

// ─── Pixel-art logo ───────────────────────────────────────────────────────────

/**
 * 5-row pink pixel-art robot using half-block chars (█ ▜ ▝).
 * Each cell encodes two stacked pixel rows: foreground = pink,
 * terminal background fills eye/mouth holes.
 *
 * Rows are space-padded to the same width so the text column lines up.
 * See LOGO_LINES for the character layout (4 rows).
 */
const LOGO_LINES: string[] = [
  '       ',
  '▐▛███▜▌',
  '▐█████▌',
  ' ▘▘ ▝▝ ',
]

const LOGO_SHADES: RGB[] = [PINK_LIGHT, PINK, PINK, PINK, PINK_DARK]

/**
 * Visible width of the logo block (ANSI-stripped). Each character in
 * LOGO_LINES occupies one terminal cell; lines are space-padded to the
 * same length, so this stays constant.
 */
const LOGO_WIDTH = LOGO_LINES[0].length

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean; effort?: EffortLevel | AdaptiveEffort } {
  const provider = tryGetActiveProvider()

  // No active profile — keep the banner honest instead of guessing Anthropic.
  // The wizard or migration banner takes over right after.
  if (!provider) {
    return {
      name: 'Not configured',
      model: modelOverride ? parseUserSpecifiedModel(modelOverride) : UNCONFIGURED_PLACEHOLDER,
      baseUrl: UNCONFIGURED_PLACEHOLDER,
      isLocal: false,
    }
  }

  const transport = provider.transport
  const baseUrl = provider.baseUrl
  const rawModel = modelOverride || provider.model
  const isLocal = isLocalProviderUrl(baseUrl)
  const extrasEffort = provider.extras?.reasoningEffort

  switch (transport) {
    case 'gemini':
    case 'mistral':
    case 'github_copilot':
      return { name: provider.name, model: rawModel, baseUrl, isLocal: false, effort: extrasEffort }
    case 'bedrock':
    case 'vertex':
    case 'foundry':
      return { name: provider.name, model: parseUserSpecifiedModel(rawModel), baseUrl, isLocal: false, effort: extrasEffort }
    case 'anthropic': {
      const resolvedModel = parseUserSpecifiedModel(rawModel)
      const effort = modelSupportsEffort(resolvedModel)
        ? getDisplayedEffortLabel(resolvedModel, getInitialEffortSetting())
        : undefined
      return { name: provider.name ?? 'Anthropic', model: resolvedModel, baseUrl, isLocal, effort }
    }
    case 'codex_responses':
    case 'openai_compat':
    default: {
      const resolvedRequest = resolveProviderRequest({
        model: rawModel,
        baseUrl,
      })
      const resolvedBaseUrl = resolvedRequest.baseUrl
      const resolvedIsLocal = isLocalProviderUrl(resolvedBaseUrl)

      let name = provider.name
      // Base URL is authoritative — must precede rawModel checks so aggregators
      // (OpenRouter/Together/Groq) aren't mislabelled as DeepSeek/Kimi/etc.
      // when routed to models whose IDs contain a vendor prefix. See issue #855.
      if (/api\.openai\.com/i.test(resolvedBaseUrl)) name = 'OpenAI'
      else if (/openrouter/i.test(resolvedBaseUrl)) name = 'OpenRouter'
      else if (/together/i.test(resolvedBaseUrl)) name = 'Together AI'
      else if (/groq/i.test(resolvedBaseUrl)) name = 'Groq'
      else if (/azure/i.test(resolvedBaseUrl)) name = 'Azure OpenAI'
      else if (/nvidia/i.test(resolvedBaseUrl)) name = 'NVIDIA NIM'
      else if (/minimax/i.test(resolvedBaseUrl)) name = 'MiniMax'
      else if (/api\.kimi\.com/i.test(resolvedBaseUrl)) name = 'Moonshot AI'
      else if (/moonshot/i.test(resolvedBaseUrl)) name = 'Moonshot AI - API'
      else if (/deepseek/i.test(resolvedBaseUrl)) name = 'DeepSeek'
      else if (/mistral/i.test(resolvedBaseUrl)) name = 'Mistral'
      else if (/z\.ai|zhipu/i.test(resolvedBaseUrl)) name = 'Z.AI'
      else if (/gateway\.ai\.cloudflare/i.test(resolvedBaseUrl)) name = 'Cloudflare AI Gateway'
      else if (/cloudflare/i.test(resolvedBaseUrl)) name = 'Cloudflare Workers AI'
      // rawModel fallback — fires only when base URL is generic/custom.
      else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
      else if (/minimax/i.test(rawModel)) name = 'MiniMax'
      else if (/\bkimi-for-coding\b/i.test(rawModel))
        name = 'Moonshot AI'
      else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
        name = 'Moonshot AI - API'
      else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
      else if (/mistral/i.test(rawModel)) name = 'Mistral'
      else if (/llama/i.test(rawModel)) name = 'Meta Llama'
      else if (/bankr/i.test(resolvedBaseUrl)) name = 'Bankr'
      else if (/bankr/i.test(rawModel)) name = 'Bankr'
      else if (resolvedIsLocal) name = getLocalOpenAICompatibleProviderLabel(resolvedBaseUrl)

      const resolvedEffort = resolvedRequest.reasoning?.effort ?? provider.extras?.reasoningEffort

      return { name, model: resolvedRequest.resolvedModel, baseUrl: resolvedBaseUrl, isLocal: resolvedIsLocal, effort: resolvedEffort }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCwd(): string {
  const cwd = process.cwd()
  const home = os.homedir()
  if (cwd === home) return '~'
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length)
  return cwd
}

function paint(text: string, color: RGB): string {
  return `${rgb(...color)}${text}${RESET}`
}

// ─── Banner builder ───────────────────────────────────────────────────────────

/**
 * Reserved width for the Ink <RawAnsi> wrapper. Banner content is variable
 * width (depends on model name / cwd length), so we pick a generous default
 * that fits typical terminals without forcing horizontal scroll on small ones.
 */
export const STARTUP_BANNER_WIDTH = 80

/**
 * Build the ANSI-escaped lines for the startup banner. Pure function.
 * Layout: 4-row pink pixel-art robot on the left, three info lines on the
 * right (rows 0..2). Row 3 of the logo extends below the text.
 */
export type UpdateNotice = {
  latest: string
}

export function buildStartupBannerLines(
  modelOverride?: string,
  updateNotice?: UpdateNotice,
): string[] {
  const p = detectProvider(modelOverride)
  const out: string[] = []

  const version = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  const sep = `${DIM}·${RESET}`

  const headerLine = `${BOLD}Claudin${RESET} ${DIM}v${version}${RESET}`
  const providerLine = p.effort
    ? `${p.name} ${sep} ${p.model} ${sep} ${effortLevelToSymbol(p.effort)} ${p.effort}`
    : `${p.name} ${sep} ${p.model}`
  const cwdLine = `${DIM}${formatCwd()}${RESET}`

  const textRows: (string | undefined)[] = [
    undefined,    // sparkle row, no text
    headerLine,   // top of head — Claudin vX.Y.Z
    providerLine, // face — Provider · model
    cwdLine,      // mouth — cwd
  ]
  const GAP = '   '

  for (let i = 0; i < LOGO_LINES.length; i++) {
    const logoCell = paint(LOGO_LINES[i], LOGO_SHADES[i] ?? PINK)
    const text = textRows[i]
    out.push(text ? `${logoCell}${GAP}${text}` : logoCell)
  }

  if (updateNotice) {
    out.push(
      `${DIM}▲ New version available ${RESET}${GREEN}(v${updateNotice.latest})${RESET}${DIM}, please run: claudin update${RESET}`,
    )
  }

  return out
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function resolveUpdateNotice(): UpdateNotice | undefined {
  const cache = readLatestVersion()
  if (!cache) return undefined
  const current = MACRO.DISPLAY_VERSION ?? MACRO.VERSION
  if (!current) return undefined
  if (cache.current !== current) return undefined
  try {
    if (!gt(cache.latest, current)) return undefined
  } catch {
    return undefined
  }
  return { latest: cache.latest }
}

let bannerPrinted = false

export function printStartupScreen(modelOverride?: string): void {
  if (process.env.CI || !process.stdout.isTTY) return
  if (bannerPrinted) return
  bannerPrinted = true

  const out = buildStartupBannerLines(modelOverride, resolveUpdateNotice())
  process.stdout.write(out.join('\n') + '\n')
}

// Logo width is exported for downstream consumers that want to render the
// banner with consistent spacing.
export { LOGO_WIDTH as STARTUP_LOGO_WIDTH }
