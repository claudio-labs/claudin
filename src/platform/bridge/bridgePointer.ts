import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from 'src/shared/debug.js'
import { isENOENT } from 'src/shared/errors.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import {
  getProjectsDir,
  sanitizePath,
} from 'src/sessions/sessionStoragePortable.js'
import { jsonParse, jsonStringify } from 'src/platform/slowOperations.js'

/**
 * Crash-recovery pointer for Remote Control sessions.
 *
 * Written immediately after a bridge session is created, periodically
 * refreshed during the session, and cleared on clean shutdown. If the
 * process dies unclean (crash, kill -9, terminal closed), the pointer
 * persists. On next startup, `claude remote-control` detects it and offers
 * to resume via the --session-id flow from #20460.
 *
 * Staleness is checked against the file's mtime (not an embedded timestamp)
 * so that a periodic re-write with the same content serves as a refresh —
 * matches the backend's rolling BRIDGE_LAST_POLL_TTL (4h) semantics. A
 * bridge that's been polling for 5+ hours and then crashes still has a
 * fresh pointer as long as the refresh ran within the window.
 *
 * Scoped per working directory (alongside transcript JSONL files) so two
 * concurrent bridges in different repos don't clobber each other.
 */

export const BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000

const BridgePointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),
    environmentId: z.string(),
    source: z.enum(['standalone', 'repl']),
  }),
)

export type BridgePointer = z.infer<ReturnType<typeof BridgePointerSchema>>

export function getBridgePointerPath(dir: string): string {
  return join(getProjectsDir(), sanitizePath(dir), 'bridge-pointer.json')
}

/**
 * Write the pointer. Also used to refresh mtime during long sessions —
 * calling with the same IDs is a cheap no-content-change write that bumps
 * the staleness clock. Best-effort — a crash-recovery file must never
 * itself cause a crash. Logs and swallows on error.
 */
export async function writeBridgePointer(
  dir: string,
  pointer: BridgePointer,
): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, jsonStringify(pointer), 'utf8')
    logForDebugging(`[bridge:pointer] wrote ${path}`)
  } catch (err: unknown) {
    logForDebugging(`[bridge:pointer] write failed: ${err}`, { level: 'warn' })
  }
}

/**
 * Read the pointer and its age (ms since last write). Operates directly
 * and handles errors — no existence check (CLAUDE.md TOCTOU rule). Returns
 * null on any failure: missing file, corrupted JSON, schema mismatch, or
 * stale (mtime > 4h ago). Stale/invalid pointers are deleted so they don't
 * keep re-prompting after the backend has already GC'd the env.
 */
export async function readBridgePointer(
  dir: string,
): Promise<(BridgePointer & { ageMs: number }) | null> {
  const path = getBridgePointerPath(dir)
  let raw: string
  let mtimeMs: number
  try {
    // stat for mtime (staleness anchor), then read. Two syscalls, but both
    // are needed — mtime IS the data we return, not a TOCTOU guard.
    mtimeMs = (await stat(path)).mtimeMs
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }

  const parsed = BridgePointerSchema().safeParse(safeJsonParse(raw))
  if (!parsed.success) {
    logForDebugging(`[bridge:pointer] invalid schema, clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  const ageMs = Math.max(0, Date.now() - mtimeMs)
  if (ageMs > BRIDGE_POINTER_TTL_MS) {
    logForDebugging(`[bridge:pointer] stale (>4h mtime), clearing: ${path}`)
    await clearBridgePointer(dir)
    return null
  }

  return { ...parsed.data, ageMs }
}

/**
 * Delete the pointer. Idempotent — ENOENT is expected when the process
 * shut down clean previously.
 */
export async function clearBridgePointer(dir: string): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await unlink(path)
    logForDebugging(`[bridge:pointer] cleared ${path}`)
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      logForDebugging(`[bridge:pointer] clear failed: ${err}`, {
        level: 'warn',
      })
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return jsonParse(raw)
  } catch {
    return null
  }
}
