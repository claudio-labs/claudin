import { chmod, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from 'src/platform/bootstrap/state.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, isFsInaccessible } from 'src/shared/errors.js'
import { isProcessRunning } from 'src/shared/proc/genericProcessUtils.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import { getAgentId } from 'src/agent/coordinator/teammate.js'
import { patchPidRecord, writePidRecord } from 'src/sessions/pidRecord.js'
import { getSessionsDir } from 'src/sessions/sessionsDir.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'

/**
 * What `~/.claudin/sessions/<pid>.json` holds. Other sessions read it: the
 * name and cwd are how ListAgents labels this session, and the messaging
 * pair is how SendMessage reaches its inbox — the token is why the file is
 * written owner-only.
 */
type SessionRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
  name?: string
  bridgeSessionId?: string | null
  messagingSocketPath?: string | null
  messagingToken?: string | null
}

// registerSession() runs once per process in production but many times over a
// test file, and every call subscribes to sessionSwitched. Holding the
// unsubscribe lets a later call drop the previous listener, so the signal does
// not accumulate PID-file writers. resetStateForTests() used to cover this by
// clearing the whole signal, which took the other subscribers down with it.
let unsubscribeSessionSwitch: (() => void) | undefined

let settleRegistration: (registered: boolean) => void = () => {}
const registration = new Promise<boolean>(resolve => {
  settleRegistration = resolve
})

/**
 * Resolves once registerSession() has written this process's PID file — true
 * — or skipped it — false. Anything that patches the record waits on this,
 * or its write would race the file into existence.
 */
export function whenSessionRegistered(): Promise<boolean> {
  return registration
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p) — so concurrency counting sees everything the user
 * might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) {
    settleRegistration(false)
    return false
  }

  const kind: SessionKind = 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)

  registerCleanup(async () => {
    try {
      await unlink(pidFile)
    } catch {
      // ENOENT is fine (already deleted or never written)
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const record: SessionRecord = {
      pid: process.pid,
      sessionId: getSessionId(),
      cwd: getOriginalCwd(),
      startedAt: Date.now(),
      kind,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }
    await writePidRecord(pidFile, record)
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale and `claude ps` sparkline
    // reads the wrong transcript.
    unsubscribeSessionSwitch?.()
    unsubscribeSessionSwitch = onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    settleRegistration(true)
    return true
  } catch (e) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    settleRegistration(false)
    return false
  }
}

/**
 * Update this session's name in its PID registry file. Best-effort:
 * silently no-op if name is falsy, the
 * file doesn't exist (session not registered), or read/write fails.
 */
async function updatePidFile(patch: Partial<SessionRecord>): Promise<void> {
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  try {
    await patchPidRecord(pidFile, patch)
  } catch (e) {
    logForDebugging(
      `[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`,
    )
  }
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/** Advertise (or withdraw, with nulls) this session's peer inbox. */
export async function updateSessionInbox(inbox: {
  messagingSocketPath: string | null
  messagingToken: string | null
}): Promise<void> {
  await updatePidFile(inbox)
}

/**
 * Follow EnterWorktree/ExitWorktree: another session names this one after its
 * directory, and a session that moved into a worktree should read as there.
 */
export async function updateSessionCwd(cwd: string): Promise<void> {
  await updatePidFile({ cwd })
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // sessions/ is shared with Windows-native Claudin (symlink or
      // CLAUDIN_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file. This is just
      // telemetry so conservative undercount is acceptable.
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
