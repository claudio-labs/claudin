// LSP server configuration types shared across the lsp service layer.
// Inferred from LspServerConfigSchema in src/utils/plugins/schemas.ts

export type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
}

export type ScopedLspServerConfig = LspServerConfig & {
  scope: 'builtin' | 'dynamic'
  source: string
}

export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
