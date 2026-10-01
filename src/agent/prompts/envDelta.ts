import type { Message } from 'src/shared/types/message.js'
import { WORKTREE_STASH_WARNING } from 'src/shared/constants/worktreeSafety.js'

/**
 * The parts of the system prompt's environment section that can move while a
 * session runs: the working directory (EnterWorktree, ExitWorktree, /cd), the
 * worktree flag, and the additional working directories (/add-dir, a
 * directory granted from a permission prompt).
 *
 * The section is computed once and frozen (systemPromptSection), because the
 * system prompt sits in front of the whole cached prefix: until 2026-10-01
 * each of those events cleared the section cache and the next request
 * rewrote everything, thinking included. Now the section keeps the session's
 * starting environment and a change is announced at the tail, as an
 * `env_delta` attachment, the way the other deltas are
 * (git_status_delta, claude_md_delta).
 */
export type EnvSnapshot = {
  cwd: string
  isWorktree: boolean
  additionalDirectories: string[]
}

let promptEnv: EnvSnapshot | null = null

/** The environment the system prompt's env section was rendered with. */
export function recordPromptEnv(snapshot: EnvSnapshot): void {
  promptEnv = snapshot
}

export function getPromptEnv(): EnvSnapshot | null {
  return promptEnv
}

/** With the sections cleared (/clear, /compact, a resume), the next render records afresh. */
export function resetPromptEnv(): void {
  promptEnv = null
}

function sameEnv(a: EnvSnapshot, b: EnvSnapshot): boolean {
  return (
    a.cwd === b.cwd &&
    a.isWorktree === b.isWorktree &&
    a.additionalDirectories.length === b.additionalDirectories.length &&
    a.additionalDirectories.every((d, i) => d === b.additionalDirectories[i])
  )
}

/**
 * The environment to announce, or null when the model already has it: the
 * last `env_delta` in the conversation, else what the system prompt says.
 * Nothing before the system prompt was rendered (`prompt` null).
 */
export function getEnvDelta(
  current: EnvSnapshot,
  prompt: EnvSnapshot | null,
  messages: readonly Message[],
): EnvSnapshot | null {
  if (!prompt) return null
  let announced = prompt
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'env_delta') {
      announced = m.attachment
    }
  }
  return sameEnv(current, announced) ? null : current
}

/** What the model reads: the same lines the env section renders. */
export function renderEnvDelta(env: EnvSnapshot): string {
  const lines = [
    'The environment changed since the start of this session; this replaces what the Environment section says:',
    `- Primary working directory: ${env.cwd}`,
    ...(env.isWorktree
      ? [
          '- This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT `cd` to the original repository root.',
          `- ${WORKTREE_STASH_WARNING}`,
        ]
      : []),
    env.additionalDirectories.length > 0
      ? `- Additional working directories: ${env.additionalDirectories.join(', ')}`
      : '- Additional working directories: none',
  ]
  return lines.join('\n')
}
