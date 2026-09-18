// These constants are in a separate file to avoid circular dependency issues.
// Do NOT add imports to this file - it must remain dependency-free.

export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'os_native',
  'notifications_disabled',
] as const

// Valid editor modes (excludes deprecated 'emacs' which is auto-migrated to 'normal')
export const EDITOR_MODES = ['normal', 'vim'] as const

export const PROVIDERS = [
  'openai',
  'anthropic',
  'mistral',
  'gemini',
  'bedrock',
  'vertex',
  'foundry',
] as const
