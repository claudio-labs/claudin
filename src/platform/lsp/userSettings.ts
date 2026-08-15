import { getInitialSettings } from 'src/platform/settings/settings.js'

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
