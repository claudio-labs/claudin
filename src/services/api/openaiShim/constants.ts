/**
 * Constants used across the openaiShim modules.
 *
 * Kept in a leaf module so every other shim file (providerModes, urlRedaction,
 * messagesClient, etc.) can import without creating cycles.
 */

export const GITHUB_COPILOT_BASE = 'https://api.githubcopilot.com'
export const GITHUB_429_MAX_RETRIES = 3
export const GITHUB_429_BASE_DELAY_SEC = 1
export const GITHUB_429_MAX_DELAY_SEC = 32

export const GEMINI_API_HOST = 'generativelanguage.googleapis.com'

export const MOONSHOT_API_HOSTS = new Set([
  'api.moonshot.ai',
  'api.moonshot.cn',
])

export const KIMI_CODE_API_HOST = 'api.kimi.com'

export const GLM_API_HOSTS = new Set([
  'api.z.ai',
  'open.bigmodel.cn',
  'bigmodel.cn',
  'api.zhipuai.cn',
])

export const DEEPSEEK_API_HOSTS = new Set([
  'api.deepseek.com',
])

export const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Editor-Version': 'vscode/1.99.3',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
}

export const SENSITIVE_URL_QUERY_PARAM_NAMES = [
  'api_key',
  'key',
  'token',
  'access_token',
  'refresh_token',
  'signature',
  'sig',
  'secret',
  'password',
  'authorization',
]
