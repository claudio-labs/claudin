import type { ChildProcess } from 'child_process'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

export const connectResponseSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    ws_url: z.string(),
    work_dir: z.string().optional(),
  }),
)


export type SessionState =
  | 'starting'
  | 'running'
  | 'detached'
  | 'stopping'
  | 'stopped'

export type SessionInfo = {
  id: string
  status: SessionState
  createdAt: number
  workDir: string
  process: ChildProcess | null
  sessionKey?: string
}

/**
 * Stable session key → session metadata. Persisted to ~/.claudin/server-sessions.json
 * so sessions can be resumed across server restarts.
 */
export type SessionIndexEntry = {
  /** Server-assigned session ID (matches the subprocess's claude session). */
  sessionId: string
  /** The claude transcript session ID for --resume. Same as sessionId for direct sessions. */
  transcriptSessionId: string
  cwd: string
  permissionMode?: string
  createdAt: number
  lastActiveAt: number
}


