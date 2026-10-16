/**
 * The Codex CLI's own ChatGPT login — `$CODEX_HOME/auth.json`, default
 * `~/.codex/auth.json` — as a credential source for the Codex provider.
 *
 * /provider links a profile to this file (`extras.codexAuthPath`) rather than
 * copying its tokens into secure storage: OpenAI rotates refresh tokens, so
 * two clients holding copies of one would log each other out on the first
 * refresh. Linked, Claudin reads the file on every request and, when the
 * access token runs out, refreshes it and writes the result back in the
 * Codex CLI's own layout, so both CLIs keep sharing one login.
 */
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { isENOENT } from 'src/shared/errors.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  asTrimmedString,
  parseChatgptAccountId,
  parseJwtExpiryMs,
  requestCodexTokenRefresh,
} from 'src/providers/oauth/codexOAuthShared.js'

const REFRESH_SKEW_MS = 60_000
const REFRESH_FAILURE_COOLDOWN_MS = 60_000

export type CodexCliLogin = {
  authPath: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId: string
}

const inFlightRefreshes = new Map<string, Promise<boolean>>()
const lastRefreshFailureAt = new Map<string, number>()

export function getCodexCliAuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHome = asTrimmedString(env.CODEX_HOME) ?? join(homedir(), '.codex')
  return join(codexHome, 'auth.json')
}

function readAuthFile(authPath: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(authPath, 'utf8')
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`[codex] could not read ${authPath}: ${String(error)}`, {
        level: 'warn',
      })
    }
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch (error) {
    logForDebugging(`[codex] ${authPath} is not valid JSON: ${String(error)}`, {
      level: 'warn',
    })
    return undefined
  }
}

function readTokens(
  authFile: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const tokens = authFile?.tokens
  return tokens && typeof tokens === 'object'
    ? (tokens as Record<string, unknown>)
    : undefined
}

/**
 * The ChatGPT login in a Codex CLI auth.json, or undefined when the file is
 * missing, holds only an API key, or lacks what a refresh and the
 * ChatGPT-Account-Id header need.
 */
export function readCodexCliLogin(
  authPath: string = getCodexCliAuthPath(),
): CodexCliLogin | undefined {
  const tokens = readTokens(readAuthFile(authPath))
  const accessToken = asTrimmedString(tokens?.access_token)
  const refreshToken = asTrimmedString(tokens?.refresh_token)
  if (!accessToken || !refreshToken) return undefined

  const idToken = asTrimmedString(tokens?.id_token)
  const accountId =
    asTrimmedString(tokens?.account_id) ??
    parseChatgptAccountId(idToken) ??
    parseChatgptAccountId(accessToken)
  if (!accountId) return undefined

  return { authPath, accessToken, refreshToken, idToken, accountId }
}

function writeAuthFile(authPath: string, contents: Record<string, unknown>): void {
  // Same-directory temp + rename: a Codex CLI reading concurrently sees the
  // old file or the new one, never a torn write.
  const tempPath = `${authPath}.${process.pid}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(contents, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tempPath, authPath)
}

/**
 * Refreshes the access token in a Codex CLI auth.json when it is about to
 * expire (or always, with `force`), writing the rotated tokens back in place.
 * Resolves false when there was nothing to refresh; rejects when the refresh
 * itself fails, after which further attempts back off for a minute.
 */
export async function refreshCodexAuthFileIfNeeded(
  authPath: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const inFlight = inFlightRefreshes.get(authPath)
  if (inFlight) return inFlight

  const authFile = readAuthFile(authPath)
  const tokens = readTokens(authFile)
  const refreshToken = asTrimmedString(tokens?.refresh_token)
  if (!authFile || !tokens || !refreshToken) return false

  if (!options?.force) {
    const expiresAt = parseJwtExpiryMs(asTrimmedString(tokens.access_token))
    if (expiresAt === undefined || expiresAt > Date.now() + REFRESH_SKEW_MS) {
      return false
    }
  }

  const failedAt = lastRefreshFailureAt.get(authPath)
  if (failedAt !== undefined && Date.now() - failedAt < REFRESH_FAILURE_COOLDOWN_MS) {
    return false
  }

  const refresh = (async () => {
    try {
      const payload = await requestCodexTokenRefresh(refreshToken)
      writeAuthFile(authPath, {
        ...authFile,
        tokens: {
          ...tokens,
          access_token: payload.access_token,
          refresh_token: payload.refresh_token ?? refreshToken,
          id_token: payload.id_token ?? tokens.id_token,
        },
        last_refresh: new Date().toISOString(),
      })
      lastRefreshFailureAt.delete(authPath)
      return true
    } catch (error) {
      lastRefreshFailureAt.set(authPath, Date.now())
      throw error
    } finally {
      inFlightRefreshes.delete(authPath)
    }
  })()
  inFlightRefreshes.set(authPath, refresh)
  return refresh
}
