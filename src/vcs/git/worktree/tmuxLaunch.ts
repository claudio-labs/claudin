/**
 * The pure half of `claudin --worktree <name> --tmux`: reading the command
 * line, naming the worktree, and the command tmux relaunches the CLI with.
 */

import type { Platform } from 'src/shared/proc/platform.js'

const WORKTREE_FLAGS: ReadonlySet<string> = new Set(['-w', '--worktree'])
const TMUX_FLAGS: ReadonlySet<string> = new Set(['--tmux', '--tmux=classic'])
const WORKTREE_ASSIGNMENT = '--worktree='

export type FastPathArgs = {
  /** The last name given; null when no occurrence named one. */
  readonly name: string | null
  readonly classic: boolean
  /** What the relaunched CLI receives, in order. */
  readonly forwarded: readonly string[]
}

/** Whether the argument after a bare `-w`/`--worktree` is its value. */
function isFlagValue(next: string | undefined): next is string {
  return next !== undefined && !next.startsWith('-')
}

export function readFastPathArgs(args: readonly string[]): FastPathArgs {
  let name: string | null = null
  let classic = false
  const forwarded: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (WORKTREE_FLAGS.has(arg)) {
      const next = args[index + 1]
      if (isFlagValue(next)) {
        name = next
        index += 1
      }
    } else if (arg.startsWith(WORKTREE_ASSIGNMENT)) {
      name = arg.slice(WORKTREE_ASSIGNMENT.length)
    } else if (TMUX_FLAGS.has(arg)) {
      if (arg === '--tmux=classic') classic = true
    } else if (arg !== '') {
      forwarded.push(arg)
    }
  }
  return { name, classic, forwarded }
}

const NAME_ADJECTIVES = ['swift', 'bright', 'calm', 'keen', 'bold'] as const
const NAME_NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray'] as const

function pick(choices: readonly string[], random: () => number): string {
  return choices[Math.floor(random() * choices.length)] ?? ''
}

/** `<adjective>-<noun>-<up to four base-36 characters>`, for a `--worktree` with no name. */
export function inventWorktreeName(random: () => number = Math.random): string {
  const suffix = random().toString(36).slice(2, 6)
  return `${pick(NAME_ADJECTIVES, random)}-${pick(NAME_NOUNS, random)}-${suffix}`
}

/** A pull request reference names its worktree `pr-<n>` and is the base. */
export function worktreeTarget(
  name: string,
  prNumber: number | null,
): { slug: string; prNumber?: number } {
  return prNumber === null ? { slug: name } : { slug: `pr-${prNumber}`, prNumber }
}

export type Launch = {
  readonly runtime: string
  /** The script the runtime was given (`node dist/cli.mjs`), absent for a compiled binary. */
  readonly script: string | null
}

/** The command line tmux runs: the CLI as it was launched, then the forwarded arguments. */
export function relaunchCommand(launch: Launch, forwarded: readonly string[]): string[] {
  return launch.script === null
    ? [launch.runtime, ...forwarded]
    : [launch.runtime, launch.script, ...forwarded]
}

export function tmuxInstallHint(platform: Platform): string {
  switch (platform) {
    case 'macos':
      return 'Install tmux with: brew install tmux'
    case 'linux':
    case 'wsl':
      return 'Install tmux with: sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora/RHEL)'
    case 'windows':
      return 'tmux is not natively available on Windows. Consider using WSL or Cygwin.'
    case 'unknown':
      return 'Install tmux using your system package manager.'
  }
}

export const ITERM_TABS_TIP =
  'Tip: to open tmux windows as iTerm2 tabs, turn on iTerm2 Settings > General > tmux > "Tabs in attaching window".'
