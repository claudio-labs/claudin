// Critical system constants extracted to break circular dependencies

import { logForDebugging } from 'src/shared/debug.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/providers/model/providers.js'

const DEFAULT_PREFIX =
  `You are Claudin, an open-source coding agent and CLI.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  `You are Claudin, an open-source coding agent and CLI running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX =
  `You are Claudin, built on the Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Check if attribution header is enabled.
 * Enabled by default, can be disabled via CLAUDIN_ATTRIBUTION_HEADER=0.
 */
function isAttributionHeaderEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_ATTRIBUTION_HEADER)
}

/**
 * The one lane where this block is read: transport 'anthropic' against
 * api.anthropic.com. Same predicate the identity HEADERS are scoped with
 * (src/providers/transport/identityHeaders.ts, fed from client.ts) — the
 * header and the prompt block must not disagree about who is calling.
 */
function isFirstPartyLane(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Enabled by default, can be disabled via CLAUDIN_ATTRIBUTION_HEADER=0.
 */
export function getAttributionHeader(
  fingerprint: string,
  deps: { isFirstPartyLane?: () => boolean } = {},
): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  // Only the first-party backend consumes this tag. On every other provider it
  // is upstream identity leaking into a third-party wire body — the prompt half
  // of the decision identityHeaders.ts already makes for the HTTP headers.
  // Both call sites (streaming.ts's filter(Boolean), sideQuery.ts's ternary)
  // drop the empty string, so the block simply does not exist off-lane.
  if (!(deps.isFirstPartyLane ?? isFirstPartyLane)()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  // NOTE: this header is block 0 of the system prompt array
  // (claude.ts:1348) and result[0] of splitSysPromptPrefix
  // (utils/api.ts:399-485) — the literal-byte anchor of Anthropic's
  // prompt-cache prefix match. Anything appended here that varies per
  // turn invalidates the entire cached prefix on every flip. The
  // previously-injected `cc_workload` tag (a 1P QoS hint for cron
  // turns) was removed for that reason — do not re-add per-turn data
  // here without first moving it past every downstream cache_control
  // breakpoint.
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};`

  logForDebugging(`attribution header ${header}`)
  return header
}
