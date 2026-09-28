/**
 * Which session a resume leaves the process in. Pure: the effects that carry
 * the plan out are in processResumedConversation.ts.
 */
import { dirname } from 'path'

import type {
  ResumedConversation,
  ResumeOptions,
} from 'src/sessions/lifecycle/restore/types.js'
import { asSessionId, type SessionId } from 'src/shared/types/ids.js'

export type ResumePlan =
  /** The conversation is taken, and none of the original session's ownership. */
  | { kind: 'fork' }
  /**
   * The process becomes the resumed session. `projectDir` is where its
   * transcript lives; null means the current project.
   */
  | { kind: 'takeOver'; sessionId: SessionId; projectDir: string | null }
  /** Nothing names a session to become: the current one carries on. */
  | { kind: 'stay' }

export function planResume(
  conversation: Pick<ResumedConversation, 'sessionId'>,
  options: Pick<ResumeOptions, 'forkSession' | 'sessionIdOverride' | 'transcriptPath'>,
): ResumePlan {
  if (options.forkSession) return { kind: 'fork' }
  const sessionId = options.sessionIdOverride || conversation.sessionId
  if (!sessionId) return { kind: 'stay' }
  return {
    kind: 'takeOver',
    sessionId: asSessionId(sessionId),
    projectDir: options.transcriptPath ? dirname(options.transcriptPath) : null,
  }
}
