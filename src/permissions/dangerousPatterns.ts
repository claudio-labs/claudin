/**
 * Command names that hand the model arbitrary code execution. An allow rule
 * for one of them would run before the auto-mode classifier sees the command.
 * The order of both exports is part of their contract.
 */

const SCRIPT_INTERPRETERS = [
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
] as const

const PACKAGE_SCRIPT_RUNNERS = [
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
] as const

const NESTED_OR_REMOTE_SHELLS = ['bash', 'sh', 'ssh'] as const

/** Unix shells and command launchers that have no PowerShell counterpart. */
const UNIX_COMMAND_LAUNCHERS = ['zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo'] as const

export const CROSS_PLATFORM_CODE_EXEC = [
  ...SCRIPT_INTERPRETERS,
  ...PACKAGE_SCRIPT_RUNNERS,
  ...NESTED_OR_REMOTE_SHELLS,
] as const

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  ...UNIX_COMMAND_LAUNCHERS,
]
