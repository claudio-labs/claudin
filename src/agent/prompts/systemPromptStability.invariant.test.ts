/**
 * Invariant: the system prompt a session sends does not move mid-session.
 *
 * The system prompt sits in front of every message in the cached prefix, so
 * one changed byte rewrites the whole history (and on Opus 5.5 drops the
 * thinking in it). Its dynamic parts are memoized sections
 * (systemPromptSections.ts), computed once; what invalidates them is
 * clearSystemPromptSections(), so the guard is on who may call it — only a
 * session boundary, where the next request starts over anyway. Something
 * that changes during a session is announced at the tail: env_delta for the
 * environment section (src/agent/prompts/envDelta.ts).
 *
 * Until 2026-10-01 EnterWorktree, ExitWorktree, /add-dir (or a directory
 * granted from a permission prompt) and /cd each cleared the sections, and
 * the next request rewrote everything.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Glob } from 'bun'
import { getEnvDelta, renderEnvDelta } from 'src/agent/prompts/envDelta.js'
import { createAttachmentMessage } from 'src/agent/attachments/attachments.js'
import type { Message } from 'src/shared/types/message.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SRC = join(REPO_ROOT, 'src')

/**
 * Every production caller of clearSystemPromptSections, and the boundary it
 * stands for. A new caller fails this test: if it runs mid-session it
 * rewrites the cached prefix, and the change belongs at the tail instead.
 */
const SESSION_BOUNDARIES: Record<string, string> = {
  'src/agent/compact/postCompactCleanup.ts': '/compact and auto-compact replace the history',
  'src/sessions/sessionRestore.ts': '/resume switches to another session (twice: entering and leaving its worktree)',
}

describe('who may clear the memoized system prompt sections', () => {
  test('only the session boundaries', () => {
    const callers = new Set<string>()
    for (const file of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$|__testutils__|__fixtures__/.test(file)) continue
      const path = join(SRC, file)
      if (file === join('agent', 'prompts', 'systemPromptSections.ts')) continue
      if (/\bclearSystemPromptSections\(\)/.test(readFileSync(path, 'utf8'))) {
        callers.add(relative(REPO_ROOT, path))
      }
    }
    expect([...callers].sort()).toEqual(Object.keys(SESSION_BOUNDARIES).sort())
  })
})

describe('environment changes go to the tail', () => {
  const start = { cwd: '/repo', isWorktree: false, additionalDirectories: [] }
  const inWorktree = { cwd: '/repo/.claudin/worktrees/a', isWorktree: true, additionalDirectories: [] }

  test('nothing to announce while the environment is what the prompt says', () => {
    expect(getEnvDelta(start, start, [])).toBeNull()
  })

  test('a move is announced once, then the announcement is the baseline', () => {
    expect(getEnvDelta(inWorktree, start, [])).toEqual(inWorktree)
    const announced: Message[] = [createAttachmentMessage({ type: 'env_delta', ...inWorktree })]
    expect(getEnvDelta(inWorktree, start, announced)).toBeNull()
    // Leaving the worktree is announced again, back to the start.
    expect(getEnvDelta(start, start, announced)).toEqual(start)
  })

  test('the announcement says what the env section would have said', () => {
    const text = renderEnvDelta({ ...inWorktree, additionalDirectories: ['/tmp/shared'] })
    expect(text).toContain('Primary working directory: /repo/.claudin/worktrees/a')
    expect(text).toContain('This is a git worktree')
    expect(text).toContain('Additional working directories: /tmp/shared')
  })
})

// What the built bundle sends (feature() folded, production flags), one
// process per permission mode a session can start in or reach: the system
// prompt must not depend on it. The scratchpad line embeds the session id —
// it is the one per-session element and sits after the cache boundary
// (SYSTEM_PROMPT_SESSION_MARKER) — so it is masked.
describe('the shipped system prompt does not depend on the permission mode', () => {
  const BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'claudin-prompt-modes-'))
  afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

  function dump(mode: string): string {
    const res = spawnSync(
      process.execPath,
      [BUNDLE, '--dump-system-prompt', '--model', 'claude-opus-5-5', '--permission-mode', mode],
      {
        encoding: 'utf8',
        timeout: 120_000,
        cwd: REPO_ROOT,
        env: { ...process.env, CLAUDIN_CONFIG_DIR: DATA_DIR, NODE_ENV: 'production' },
      },
    )
    if (typeof res.stdout !== 'string' || res.stdout === '') {
      throw new Error(`${BUNDLE} --permission-mode ${mode} printed nothing (status=${res.status})`)
    }
    return res.stdout.replace(/^Scratchpad directory: .*$/m, 'Scratchpad directory: <session>')
  }

  test('the bundle exists', () => {
    expect(existsSync(BUNDLE) ? 'present' : `MISSING — run \`bun run build\` first: ${BUNDLE}`).toBe(
      'present',
    )
  })

  test.skipIf(!existsSync(BUNDLE))('default, plan, acceptEdits, bypassPermissions and auto send the same prompt', () => {
    const base = dump('default')
    for (const mode of ['plan', 'acceptEdits', 'bypassPermissions', 'auto']) {
      expect({ mode, same: dump(mode) === base }).toEqual({ mode, same: true })
    }
  }, 120_000)
})
