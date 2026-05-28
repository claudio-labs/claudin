import { getInitialSettings } from '../../utils/settings/settings.js'

export type UserLspServerSetting = {
  disabled?: boolean
  command?: string[]
  extensions?: string[]
}

// Reserved keys at lsp.* that are not server names.
const RESERVED_LSP_KEYS = new Set(['enabled', 'diagnosticsTimeoutMs'])

export function getUserLspSettings(): Record<string, UserLspServerSetting> {
  try {
    const lsp = (getInitialSettings().lsp ?? {}) as Record<string, unknown>
    const out: Record<string, UserLspServerSetting> = {}
    for (const [key, value] of Object.entries(lsp)) {
      if (RESERVED_LSP_KEYS.has(key)) continue
      if (value && typeof value === 'object') {
        out[key] = value as UserLspServerSetting
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Master toggle for the LSP subsystem. Default: true (enabled).
 * When false: no servers connect, no diagnostics emitted.
 */
export function isLspGloballyEnabled(): boolean {
  try {
    const lsp = getInitialSettings().lsp as { enabled?: boolean } | undefined
    return lsp?.enabled !== false
  } catch {
    return true
  }
}
