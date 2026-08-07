import { tryGetActiveProvider } from '../services/api/activeProvider.js'
import {
  getGithubEndpointType,
  isLocalProviderUrl,
  resolveCodexApiCredentials,
  resolveProviderRequest,
} from '../services/api/providerConfig.js'
import { isBareMode } from './envUtils.js'
import {
  type GeminiResolvedCredential,
  resolveGeminiCredential,
} from './geminiAuth.js'

type GithubTokenStatus = 'valid' | 'expired' | 'invalid_format'

const GITHUB_PAT_PREFIXES = ['ghp_', 'gho_', 'ghs_', 'ghr_', 'github_pat_']

function checkGithubTokenStatus(
  token: string,
  endpointType: 'copilot' | 'models' | 'custom' = 'copilot',
): GithubTokenStatus {
  // PATs work with GitHub Models but not with Copilot API
  if (GITHUB_PAT_PREFIXES.some(prefix => token.startsWith(prefix))) {
    if (endpointType === 'copilot') {
      return 'expired'
    }
    return 'valid'
  }

  const expMatch = token.match(/exp=(\d+)/)
  if (expMatch) {
    const expSeconds = Number(expMatch[1])
    if (!Number.isNaN(expSeconds)) {
      return Date.now() >= expSeconds * 1000 ? 'expired' : 'valid'
    }
  }

  const parts = token.split('.')
  const looksLikeJwt =
    parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))
  if (looksLikeJwt) {
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const json = Buffer.from(padded, 'base64').toString('utf8')
      const parsed = JSON.parse(json)
      if (parsed && typeof parsed === 'object' && parsed.exp) {
        return Date.now() >= (parsed.exp as number) * 1000 ? 'expired' : 'valid'
      }
    } catch {
      return 'invalid_format'
    }
  }

  // Keep compatibility with opaque token formats that do not expose expiry.
  return 'valid'
}

export async function getProviderValidationError(
  _env?: NodeJS.ProcessEnv,
  options?: {
    resolveGeminiCredential?: (
      env: NodeJS.ProcessEnv,
    ) => Promise<GeminiResolvedCredential>
  },
): Promise<string | null> {
  const profile = tryGetActiveProvider()
  if (!profile) return null

  if (profile.transport === 'gemini') {
    const geminiCredential = await (
      options?.resolveGeminiCredential ?? resolveGeminiCredential
    )(process.env)
    if (geminiCredential.kind === 'none') {
      return 'Configure Gemini auth via /provider — pick API key, access token, or rely on Google ADC.'
    }
    return null
  }

  if (profile.transport === 'github_copilot') {
    const token = profile.extras?.githubToken?.trim() || profile.apiKey?.trim() || ''
    if (!token) {
      return 'GitHub Copilot authentication required.\nRun /provider and choose GitHub Copilot.'
    }
    const endpointType = getGithubEndpointType(profile.baseUrl)
    const status = checkGithubTokenStatus(token, endpointType)
    if (status === 'expired') {
      return 'GitHub Copilot token has expired.\nRun /provider and choose GitHub Copilot.'
    }
    if (status === 'invalid_format') {
      return 'GitHub Copilot token is invalid or corrupted.\nRun /provider and choose GitHub Copilot.'
    }
    return null
  }

  if (
    profile.transport !== 'openai_compat' &&
    profile.transport !== 'codex_responses'
  ) {
    return null
  }

  const request = resolveProviderRequest({
    model: profile.model,
    baseUrl: profile.baseUrl,
  })

  if (profile.apiKey === 'SUA_CHAVE') {
    return 'Invalid API key: placeholder value SUA_CHAVE detected. Set a real key in /provider, or leave blank for local providers.'
  }

  if (request.transport === 'codex_responses') {
    const credentials = resolveCodexApiCredentials()
    if (!credentials.apiKey) {
      const oauthHint = isBareMode() ? '' : ', choose Codex OAuth in /provider'
      const authHint = credentials.authPath
        ? `${oauthHint} or put auth.json at ${credentials.authPath}`
        : oauthHint
      return `Codex auth is required for ${request.requestedModel}. Configure it via /provider${authHint}.`
    }
    if (!credentials.accountId) {
      return 'Codex auth is missing chatgpt_account_id. Re-login with Codex OAuth via /provider, or import an auth.json with chatgpt_account_id.'
    }
    return null
  }

  if (!profile.apiKey && !isLocalProviderUrl(request.baseUrl)) {
    return 'API key required for the active /provider profile. Run /provider to set it.'
  }

  return null
}


export function shouldExitForStartupProviderValidationError(options: {
  args?: string[]
  stdoutIsTTY?: boolean
} = {}): boolean {
  const args = options.args ?? process.argv.slice(2)
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY

  if (!stdoutIsTTY) {
    return true
  }

  return (
    args.includes('-p') ||
    args.includes('--print') ||
    args.includes('--init-only') ||
    args.some(arg => arg.startsWith('--sdk-url'))
  )
}

export async function validateProviderEnvForStartupOrExit(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    args?: string[]
    stdoutIsTTY?: boolean
  },
): Promise<void> {
  const error = await getProviderValidationError(env)
  if (!error) {
    return
  }

  if (shouldExitForStartupProviderValidationError(options)) {
    console.error(error)
    process.exit(1)
  }

  console.error(
    `Warning: provider configuration is incomplete.\n${error}\nClaudin will continue starting so you can run /provider and repair the saved provider settings.`,
  )
}
