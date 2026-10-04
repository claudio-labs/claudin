import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { getOauthConfig } from 'src/shared/constants/oauth.js'
import { getClaudeAIOAuthTokens } from 'src/providers/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { errorMessage } from 'src/shared/errors.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { isEssentialTrafficOnly } from 'src/platform/config/privacyLevel.js'
import { clearMcpAuthCache } from 'src/mcp/client/authCache.js'
import { listingEligibility } from 'src/mcp/claudeaiConnectors/eligibility.js'
import { type ListedConnector, nameConnectors } from 'src/mcp/claudeaiConnectors/naming.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'

/** One page of `/v1/mcp_servers`; `has_more` is not followed (tracked). */
type ConnectorPage = { data: ListedConnector[] }

const LISTING_PATH = '/v1/mcp_servers?limit=1000'
const LISTING_TIMEOUT_MS = 5_000
const LISTING_HEADERS = {
  'anthropic-beta': 'mcp-servers-2025-12-04',
  'anthropic-version': '2023-06-01',
  'Content-Type': 'application/json',
} as const

async function listConnectors(accessToken: string): Promise<ListedConnector[]> {
  const response = await axios.get<ConnectorPage>(getOauthConfig().BASE_API_URL + LISTING_PATH, {
    headers: { ...LISTING_HEADERS, Authorization: `Bearer ${accessToken}` },
    timeout: LISTING_TIMEOUT_MS,
  })
  return response.data.data ?? []
}

export const fetchClaudeAIMcpConfigsIfEligible = memoize(
  async (): Promise<Record<string, ScopedMcpServerConfig>> => {
    const eligibility = listingEligibility({
      provider: getAPIProvider(),
      essentialTrafficOnly: isEssentialTrafficOnly(),
      switchedOff: isEnvDefinedFalsy(process.env.ENABLE_CLAUDEAI_MCP_SERVERS),
      readTokens: getClaudeAIOAuthTokens,
    })
    if (!eligibility.eligible) {
      logForDebugging(`[claudeai-mcp] connector listing skipped: ${eligibility.reason}`)
      return {}
    }
    try {
      return nameConnectors(await listConnectors(eligibility.accessToken))
    } catch (error) {
      logForDebugging(`[claudeai-mcp] connector listing failed: ${errorMessage(error)}`)
      return {}
    }
  },
)

export function clearClaudeAIMcpConfigsCache(): void {
  fetchClaudeAIMcpConfigsIfEligible.cache.clear?.()
  clearMcpAuthCache()
}

export function markClaudeAiMcpConnected(name: string): void {
  saveGlobalConfig(config => {
    const known = config.claudeAiMcpEverConnected ?? []
    if (known.includes(name)) return config
    return { ...config, claudeAiMcpEverConnected: [...known, name] }
  })
}

export function hasClaudeAiMcpEverConnected(name: string): boolean {
  return getGlobalConfig().claudeAiMcpEverConnected?.includes(name) ?? false
}
