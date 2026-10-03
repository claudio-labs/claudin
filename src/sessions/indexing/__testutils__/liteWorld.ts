/**
 * The world the `sessions/liteMetadata` characterization suites run in.
 *
 * Every test gets a fresh temp root holding a config home (pointed at by
 * CLAUDIN_CONFIG_DIR) and a project directory that becomes the original cwd.
 * Transcripts are real JSONL files written into the project's session
 * directory. The bootstrap session state a test moves is put back afterwards.
 *
 * Lines are laid out in the transcript writer's key order, so the raw string
 * scans of the lite reader see what they see on a real disk.
 */
import { afterEach, beforeEach } from 'bun:test'
import type { UUID } from 'crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  switchSession,
} from 'src/platform/bootstrap/state.js'
import { envSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { clearSessionMessagesCache, getProjectDir } from 'src/sessions/sessionStorage.js'
import { asSessionId } from 'src/shared/types/ids.js'

export type Line = Record<string, unknown>

export type LiteWorld = {
  /** The temp root; everything below is deleted after the test. */
  readonly root: string
  /** The original cwd of the process during the test. */
  readonly project: string
  /** Where the project's transcripts live. */
  readonly sessionsDir: string
  /**
   * Write `<sessionsDir>/<id>.jsonl` (or `dir/<id>.jsonl`), optionally with an
   * mtime in seconds. A string is written as the raw line it is.
   */
  write(id: string, lines: ReadonlyArray<Line | string>, opts?: { mtime?: number; dir?: string }): string
}

export function useLiteWorld(): LiteWorld {
  const state = { root: '', project: '' }
  let env = envSnapshot([])
  let previous = { cwd: '', session: '', sessionDir: null as string | null }

  beforeEach(() => {
    env = envSnapshot(['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_PRECOMPACT_SKIP'])
    previous = { cwd: getOriginalCwd(), session: getSessionId(), sessionDir: getSessionProjectDir() }
    state.root = realpathSync(mkdtempSync(join(tmpdir(), 'lite-metadata-')))
    state.project = join(state.root, 'work', 'shop')
    mkdirSync(state.project, { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(state.root, 'home')
    delete process.env.CLAUDIN_DISABLE_PRECOMPACT_SKIP
    setOriginalCwd(state.project)
    getProjectDir.cache.clear!()
    clearSessionMessagesCache()
  })

  afterEach(() => {
    switchSession(asSessionId(previous.session), previous.sessionDir)
    setOriginalCwd(previous.cwd)
    env.restore()
    getProjectDir.cache.clear!()
    clearSessionMessagesCache()
    rmSync(state.root, { recursive: true, force: true })
  })

  return {
    get root() {
      return state.root
    },
    get project() {
      return state.project
    },
    get sessionsDir() {
      return getProjectDir(state.project)
    },
    write(id, lines, opts = {}) {
      const dir = opts.dir ?? getProjectDir(state.project)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${id}.jsonl`)
      writeFileSync(file, lines.map(line => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''))
      if (opts.mtime !== undefined) utimesSync(file, opts.mtime, opts.mtime)
      return file
    },
  }
}

// --- ids and clocks ---------------------------------------------------------

/** A UUID whose last group is `n`, so tests can name messages by number. */
export function uid(n: number, family = 'c0ffee00'): UUID {
  return `${family}-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

export const SESSION_A: UUID = 'a11ce000-1111-4222-8333-444455556666'
export const SESSION_B: UUID = 'b0b00000-1111-4222-8333-444455556666'
export const SESSION_C: UUID = 'cafe0000-1111-4222-8333-444455556666'

/** `2026-09-28T10:00:<s>.000Z`, s seconds past ten o'clock. */
export function at(s: number): string {
  return new Date(Date.UTC(2026, 8, 28, 10, 0, s)).toISOString()
}

// --- lines ------------------------------------------------------------------

export type Turn = {
  kind: 'user' | 'assistant' | 'system' | 'attachment'
  content?: unknown
  /** Seconds past ten; defaults to the turn's position. */
  t?: number
  /** Overrides the uuid number; defaults to the turn's position + 1. */
  n?: number
  /** Overrides the parent (a uuid number); null for a root. Defaults to the previous turn. */
  parent?: number | null
  extra?: Line
}

export type ChatOptions = {
  sessionId?: string
  cwd?: string
  branch?: string
  family?: string
}

function body(turn: Turn, n: number): Line {
  if (turn.kind === 'user') return { message: { role: 'user', content: turn.content ?? '' } }
  if (turn.kind === 'assistant') {
    const content = typeof turn.content === 'string' ? [{ type: 'text', text: turn.content }] : turn.content
    return { message: { id: `msg_${n}`, role: 'assistant', type: 'message', content: content ?? [] } }
  }
  if (turn.kind === 'system') return { subtype: 'informational', content: turn.content ?? 'note' }
  return { attachment: turn.content ?? { type: 'todo_reminder', content: [] } }
}

/** A conversation chained by parentUuid, in the writer's key order. */
export function chat(turns: readonly Turn[], options: ChatOptions = {}): Line[] {
  const sessionId = options.sessionId ?? SESSION_A
  let prev: number | null = null
  return turns.map((turn, index) => {
    const n = turn.n ?? index + 1
    const parent = turn.parent === undefined ? prev : turn.parent
    prev = n
    const line: Line = {
      parentUuid: parent === null ? null : uid(parent, options.family),
      isSidechain: false,
      type: turn.kind,
      ...body(turn, n),
      uuid: uid(n, options.family),
      timestamp: at(turn.t ?? index),
      userType: 'external',
      entrypoint: 'cli',
      cwd: options.cwd ?? '/home/dev/shop',
      sessionId,
      version: '1.4.2',
      gitBranch: options.branch ?? 'main',
    }
    return { ...line, ...turn.extra }
  })
}

/** Session-scoped metadata entries, shaped as the writer appends them. */
export const meta = {
  title: (customTitle: string, sessionId = SESSION_A): Line => ({ type: 'custom-title', customTitle, sessionId }),
  aiTitle: (aiTitle: string, sessionId = SESSION_A): Line => ({ type: 'ai-title', aiTitle, sessionId }),
  tag: (tag: string, sessionId = SESSION_A): Line => ({ type: 'tag', tag, sessionId }),
  lastPrompt: (lastPrompt: string, sessionId = SESSION_A): Line => ({ type: 'last-prompt', lastPrompt, sessionId }),
  agentSetting: (agentSetting: string, sessionId = SESSION_A): Line => ({ type: 'agent-setting', agentSetting, sessionId }),
  agentName: (agentName: string, sessionId = SESSION_A): Line => ({ type: 'agent-name', agentName, sessionId }),
  agentColor: (agentColor: string, sessionId = SESSION_A): Line => ({ type: 'agent-color', agentColor, sessionId }),
  mode: (mode: string, sessionId = SESSION_A): Line => ({ type: 'mode', mode, sessionId }),
  summary: (summary: string, leaf: number): Line => ({ type: 'summary', summary, leafUuid: uid(leaf) }),
  pr: (prNumber: unknown, sessionId = SESSION_A): Line => ({
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl: `https://github.com/acme/shop/pull/${String(prNumber)}`,
    prRepository: 'acme/shop',
    timestamp: at(50),
  }),
  cost: (totalCostUSD: number, sessionId = SESSION_A): Line => ({
    type: 'cost-state',
    sessionId,
    totalCostUSD,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 0,
    startTime: 1790589600000,
    modelUsage: {},
  }),
  worktree: (worktreeSession: unknown, sessionId = SESSION_A): Line => ({ type: 'worktree-state', worktreeSession, sessionId }),
}

/** An assistant reply that reports token usage, for the context-size figure. */
export function billedReply(
  text: string,
  usage: Record<'input_tokens' | 'output_tokens', number> & Record<string, number | null>,
  extra: Line = {},
): Turn {
  const message = { id: `msg_${text}`, role: 'assistant', type: 'message', usage, content: [{ type: 'text', text }] }
  return { kind: 'assistant', extra: { message, ...extra } }
}

/** Filler that makes a line long: `kb` KiB of a user prompt. */
export function padding(kb: number): string {
  return 'lorem ipsum '.repeat(Math.ceil((kb * 1024) / 12)).slice(0, kb * 1024)
}
