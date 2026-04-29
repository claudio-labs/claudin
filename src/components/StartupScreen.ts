/**
 * Claudio startup screen — filled-block text logo with sunset gradient.
 * Called once at CLI startup before the Ink UI renders.
 */

import { tryGetActiveProvider } from '../services/api/activeProvider.js'
import { isLocalProviderUrl, resolveProviderRequest } from '../services/api/providerConfig.js'
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'

const UNCONFIGURED_PLACEHOLDER = '—'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const ESC = '\x1b['
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`

type RGB = [number, number, number]
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]
  return lerp(stops[i], stops[i + 1], s - i)
}

function paintLine(text: string, stops: RGB[], lineT: number): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? lineT * 0.5 + (i / (text.length - 1)) * 0.5 : lineT
    const [r, g, b] = gradAt(stops, t)
    out += `${rgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const SUNSET_GRAD: RGB[] = [
  [255, 180, 100],
  [240, 140, 80],
  [217, 119, 87],
  [193, 95, 60],
  [160, 75, 55],
  [130, 60, 50],
]

const ACCENT: RGB = [240, 148, 100]
const CREAM: RGB = [220, 195, 170]
const DIMCOL: RGB = [120, 100, 82]
const BORDER: RGB = [100, 80, 65]

// ─── Filled Block Text Logo ───────────────────────────────────────────────────

const LOGO_OPEN = [
  `  ████████╗ ████████╗ ████████╗ ██╗  ██╗`,
  `  ██╔═══██║ ██╔═══██║ ██╔═════╝ ███╗ ██║`,
  `  ██║   ██║ ████████║ ██████╗   ████╗██║`,
  `  ██║   ██║ ██╔═════╝ ██╔═══╝   ██╔████║`,
  `  ████████║ ██║       ████████╗ ██║ ╚███║`,
  `  ╚═══════╝ ╚═╝       ╚═══════╝ ╚═╝  ╚══╝`,
]

const LOGO_CLAUDE = [
  `  ████████╗ ██╗      ████████╗ ██╗   ██╗ ████████╗ ████████╗`,
  `  ██╔═════╝ ██║      ██╔═══██║ ██║   ██║ ██╔═══██║ ██╔═════╝`,
  `  ██║       ██║      ████████║ ██║   ██║ ██║   ██║ ██████╗  `,
  `  ██║       ██║      ██╔═══██║ ██║   ██║ ██║   ██║ ██╔═══╝  `,
  `  ████████╗ ████████╗██║   ██║ ╚██████╔╝ ████████║ ████████╗`,
  `  ╚═══════╝ ╚═══════╝╚═╝   ╚═╝  ╚═════╝  ╚═══════╝ ╚═══════╝`,
]

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean } {
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

  switch (transport) {
    case 'gemini':
      return { name: 'Google Gemini', model: rawModel, baseUrl, isLocal: false }
    case 'mistral':
      return { name: 'Mistral', model: rawModel, baseUrl, isLocal: false }
    case 'github_copilot':
      return { name: 'GitHub Copilot', model: rawModel, baseUrl, isLocal: false }
    case 'bedrock':
      return { name: 'AWS Bedrock', model: parseUserSpecifiedModel(rawModel), baseUrl, isLocal: false }
    case 'vertex':
      return { name: 'Google Vertex', model: parseUserSpecifiedModel(rawModel), baseUrl, isLocal: false }
    case 'foundry':
      return { name: 'Azure Foundry', model: parseUserSpecifiedModel(rawModel), baseUrl, isLocal: false }
    case 'anthropic': {
      return {
        name: 'Anthropic',
        model: parseUserSpecifiedModel(rawModel),
        baseUrl,
        isLocal,
      }
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

      let name = 'OpenAI'
      if (
        resolvedRequest.transport === 'codex_responses' ||
        resolvedBaseUrl.includes('chatgpt.com/backend-api/codex')
      )
        name = 'Codex'
      // Base URL is authoritative — must precede rawModel checks so aggregators
      // (OpenRouter/Together/Groq) aren't mislabelled as DeepSeek/Kimi/etc.
      // when routed to models whose IDs contain a vendor prefix. See issue #855.
      else if (/openrouter/i.test(resolvedBaseUrl)) name = 'OpenRouter'
      else if (/together/i.test(resolvedBaseUrl)) name = 'Together AI'
      else if (/groq/i.test(resolvedBaseUrl)) name = 'Groq'
      else if (/azure/i.test(resolvedBaseUrl)) name = 'Azure OpenAI'
      else if (/nvidia/i.test(resolvedBaseUrl)) name = 'NVIDIA NIM'
      else if (/minimax/i.test(resolvedBaseUrl)) name = 'MiniMax'
      else if (/api\.kimi\.com/i.test(resolvedBaseUrl)) name = 'Moonshot AI - Kimi Code'
      else if (/moonshot/i.test(resolvedBaseUrl)) name = 'Moonshot AI - API'
      else if (/deepseek/i.test(resolvedBaseUrl)) name = 'DeepSeek'
      else if (/mistral/i.test(resolvedBaseUrl)) name = 'Mistral'
      // rawModel fallback — fires only when base URL is generic/custom.
      else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
      else if (/minimax/i.test(rawModel)) name = 'MiniMax'
      else if (/\bkimi-for-coding\b/i.test(rawModel))
        name = 'Moonshot AI - Kimi Code'
      else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
        name = 'Moonshot AI - API'
      else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
      else if (/mistral/i.test(rawModel)) name = 'Mistral'
      else if (/llama/i.test(rawModel)) name = 'Meta Llama'
      else if (/bankr/i.test(resolvedBaseUrl)) name = 'Bankr'
      else if (/bankr/i.test(rawModel)) name = 'Bankr'
      else if (resolvedIsLocal) name = getLocalOpenAICompatibleProviderLabel(resolvedBaseUrl)

      // Resolve model alias to actual model name + reasoning effort
      let displayModel = resolvedRequest.resolvedModel
      const reasoningEffort =
        resolvedRequest.reasoning?.effort ?? provider.extras?.reasoningEffort
      if (reasoningEffort) {
        displayModel = `${displayModel} (${reasoningEffort})`
      }

      return { name, model: displayModel, baseUrl: resolvedBaseUrl, isLocal: resolvedIsLocal }
    }
  }
}

// ─── Box drawing ──────────────────────────────────────────────────────────────

function boxRow(content: string, width: number, rawLen: number): string {
  const pad = Math.max(0, width - 2 - rawLen)
  return `${rgb(...BORDER)}│${RESET}${content}${' '.repeat(pad)}${rgb(...BORDER)}│${RESET}`
}

// ─── Banner builder ───────────────────────────────────────────────────────────

/**
 * Width the banner is painted to. Each row is exactly W cells wide on screen.
 * Used by both `printStartupScreen` (stdout) and the `<StartupBanner>` Ink
 * component (alt-buffer rendering for flicker-free mode).
 */
export const STARTUP_BANNER_WIDTH = 62

/**
 * Build the ANSI-escaped lines for the startup banner. Pure function.
 * Used by `printStartupScreen` (writes directly to stdout for the
 * non-fullscreen path) and by `<StartupBanner>` (renders via <RawAnsi>
 * inside the alt-screen for the flicker-free path).
 */
export function buildStartupBannerLines(modelOverride?: string): string[] {
  const p = detectProvider(modelOverride)
  const W = STARTUP_BANNER_WIDTH
  const out: string[] = []

  out.push('')

  // Gradient logo
  const allLogo = [...LOGO_OPEN, '', ...LOGO_CLAUDE]
  const total = allLogo.length
  for (let i = 0; i < total; i++) {
    const t = total > 1 ? i / (total - 1) : 0
    if (allLogo[i] === '') {
      out.push('')
    } else {
      out.push(paintLine(allLogo[i], SUNSET_GRAD, t))
    }
  }

  out.push('')

  // Tagline
  out.push(`  ${rgb(...ACCENT)}✦${RESET} ${rgb(...CREAM)}Any model. Every tool. Zero limits.${RESET} ${rgb(...ACCENT)}✦${RESET}`)
  out.push('')

  // Provider info box
  out.push(`${rgb(...BORDER)}╔${'═'.repeat(W - 2)}╗${RESET}`)

  const lbl = (k: string, v: string, c: RGB = CREAM): [string, number] => {
    const padK = k.padEnd(9)
    return [` ${DIM}${rgb(...DIMCOL)}${padK}${RESET} ${rgb(...c)}${v}${RESET}`, ` ${padK} ${v}`.length]
  }

  const provC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  let [r, l] = lbl('Provider', p.name, provC)
  out.push(boxRow(r, W, l))
  ;[r, l] = lbl('Model', p.model)
  out.push(boxRow(r, W, l))
  const ep = p.baseUrl.length > 38 ? p.baseUrl.slice(0, 35) + '...' : p.baseUrl
  ;[r, l] = lbl('Endpoint', ep)
  out.push(boxRow(r, W, l))

  out.push(`${rgb(...BORDER)}╠${'═'.repeat(W - 2)}╣${RESET}`)

  const sC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  const sL = p.isLocal ? 'local' : 'cloud'
  const sRow = ` ${rgb(...sC)}●${RESET} ${DIM}${rgb(...DIMCOL)}${sL}${RESET}    ${DIM}${rgb(...DIMCOL)}Ready — type ${RESET}${rgb(...ACCENT)}/help${RESET}${DIM}${rgb(...DIMCOL)} to begin${RESET}`
  const sLen = ` ● ${sL}    Ready — type /help to begin`.length
  out.push(boxRow(sRow, W, sLen))

  out.push(`${rgb(...BORDER)}╚${'═'.repeat(W - 2)}╝${RESET}`)
  out.push(`  ${DIM}${rgb(...DIMCOL)}claudio ${RESET}${rgb(...ACCENT)}v${MACRO.DISPLAY_VERSION ?? MACRO.VERSION}${RESET}`)
  out.push('')

  return out
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let bannerPrinted = false

export function printStartupScreen(modelOverride?: string): void {
  if (process.env.CI || !process.stdout.isTTY) return
  if (bannerPrinted) return
  bannerPrinted = true

  const out = buildStartupBannerLines(modelOverride)
  process.stdout.write(out.join('\n') + '\n')
}
