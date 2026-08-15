import * as React from 'react'

import {
  XaiOAuthService,
  type XaiDeviceCodeResponse,
  type XaiOAuthTokens,
} from 'src/services/api/xaiOAuth.js'
import { isBareMode } from 'src/shared/envUtils.js'
import { saveXaiCredentials } from 'src/services/api/xaiCredentials.js'

export type XaiOAuthFlowStatus =
  | { state: 'starting' }
  | {
      state: 'waiting'
      userCode: string
      verificationUri: string
      verificationUriComplete?: string
    }
  | {
      state: 'error'
      message: string
    }

type PersistXaiOAuthCredentials = (options?: {
  profileId?: string
}) => void

type XaiOAuthServiceLike = Pick<
  XaiOAuthService,
  'startDeviceFlow' | 'cleanup'
>

type XaiOAuthFlowDependencies = {
  createOAuthService?: () => XaiOAuthServiceLike
  saveXaiCredentials?: typeof saveXaiCredentials
  isBareMode?: typeof isBareMode
}

function createDefaultOAuthService(): XaiOAuthServiceLike {
  return new XaiOAuthService()
}

export function useXaiOAuthFlow(options: {
  onAuthenticated: (
    tokens: XaiOAuthTokens,
    persistCredentials: PersistXaiOAuthCredentials,
  ) => void | Promise<void>
  deps?: XaiOAuthFlowDependencies
}): XaiOAuthFlowStatus {
  const { onAuthenticated } = options
  const createOAuthService =
    options.deps?.createOAuthService ?? createDefaultOAuthService
  const saveCredentials =
    options.deps?.saveXaiCredentials ?? saveXaiCredentials
  const isBareModeFn = options.deps?.isBareMode ?? isBareMode
  const [status, setStatus] = React.useState<XaiOAuthFlowStatus>({
    state: 'starting',
  })

  React.useEffect(() => {
    if (isBareModeFn()) {
      setStatus({
        state: 'error',
        message:
          'xAI OAuth is unavailable in --bare because secure storage is disabled.',
      })
      return
    }

    let cancelled = false
    const oauthService = createOAuthService()

    void oauthService
      .startDeviceFlow(async (device: XaiDeviceCodeResponse) => {
        if (cancelled) return
        setStatus({
          state: 'waiting',
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: device.verification_uri_complete,
        })
      })
      .then(async tokens => {
        if (cancelled) return

        const persistCredentials: PersistXaiOAuthCredentials = options => {
          const saved = saveCredentials({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            expiresAt: tokens.expiresAt,
            profileId: options?.profileId,
          })
          if (!saved.success) {
            throw new Error(
              saved.warning ??
                'xAI OAuth succeeded, but credentials could not be saved securely.',
            )
          }
        }

        await onAuthenticated(tokens, persistCredentials)
      })
      .catch(error => {
        if (cancelled) return
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      oauthService.cleanup()
    }
  }, [createOAuthService, isBareModeFn, onAuthenticated, saveCredentials])

  return status
}
