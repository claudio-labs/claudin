import axios from 'axios'
import { getOauthConfig } from 'src/shared/constants/oauth.js'
import { getOrganizationUUID } from 'src/providers/oauth/client.js'
import { getClaudeAIOAuthTokens } from 'src/providers/auth/auth.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { getOAuthHeaders } from 'src/platform/teleport/api.js'

export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
export type EnvironmentState = 'active'

export type EnvironmentResource = {
  kind: EnvironmentKind
  environment_id: string
  name: string
  created_at: string
  state: EnvironmentState
}

export type EnvironmentListResponse = {
  environments: EnvironmentResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

/**
 * Fetches the list of available environments from the Environment API
 * @returns Promise<EnvironmentResource[]> Array of available environments
 * @throws Error if the API request fails or no access token is available
 */
export async function fetchEnvironments(): Promise<EnvironmentResource[]> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error(
      'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers`

  try {
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    const response = await axios.get<EnvironmentListResponse>(url, {
      headers,
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch environments: ${response.status} ${response.statusText}`,
      )
    }

    return response.data.environments
  } catch (error) {
    const err = toError(error)
    logError(err)
    throw new Error(`Failed to fetch environments: ${err.message}`)
  }
}
