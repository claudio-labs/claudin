import axios from 'axios'
import { getOauthConfig } from 'src/shared/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/providers/oauth/types.js'
import { logError } from 'src/shared/log.js'

export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    logError(error as Error)
  }
}
