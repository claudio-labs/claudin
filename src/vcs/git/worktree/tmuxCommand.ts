/**
 * The one way this unit runs tmux.
 *
 * Every call passes the current `process.env` explicitly: under Bun, a
 * spawnSync without `env` gets the environment the process started with,
 * which can name another tmux server or another PATH than the one in effect.
 * Session targets are always exact (`=name`), because a bare name falls back
 * to prefix matching and could reach another session.
 */

import { spawnSync } from 'child_process'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'

export type TmuxOutcome = { ok: boolean; stdout: string; stderr: string }

export function exactSession(name: string): string {
  return `=${name}`
}

export async function tmux(...args: string[]): Promise<TmuxOutcome> {
  const { code, stdout, stderr } = await execFileNoThrowWithCwd('tmux', args, {
    env: process.env,
    stdin: 'ignore',
  })
  return { ok: code === 0, stdout, stderr }
}

/** Runs tmux in the foreground on this terminal until it exits (detach or session end). */
export function tmuxInForeground(args: string[]): void {
  spawnSync('tmux', args, { env: process.env, stdio: 'inherit' })
}
