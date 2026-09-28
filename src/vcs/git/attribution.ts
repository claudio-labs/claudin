import { getClientType } from 'src/platform/bootstrap/state.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { getRemoteSessionUrl, isRemoteSessionLocal } from 'src/shared/constants/product.js'

export type AttributionTexts = { commit: string; pr: string }

const NOTHING: AttributionTexts = { commit: '', pr: '' }

/**
 * The text that ends a commit message and a pull request body. It is the
 * user's to set, word for word, and nothing by default. A remote session
 * ignores the settings: the remote runtime configures it, and the link back to
 * the session is how its commits are traced.
 */
export function getAttributionTexts(): AttributionTexts {
  return getClientType() === 'remote' ? remoteSessionTexts() : configuredTexts()
}

function configuredTexts(): AttributionTexts {
  const { commit = '', pr = '' } = getInitialSettings().attribution ?? {}
  return { commit, pr }
}

function remoteSessionTexts(): AttributionTexts {
  const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const ingressUrl = process.env.SESSION_INGRESS_URL
  if (!sessionId || isRemoteSessionLocal(sessionId, ingressUrl)) return { ...NOTHING }
  const link = getRemoteSessionUrl(sessionId, ingressUrl)
  return { commit: link, pr: link }
}
