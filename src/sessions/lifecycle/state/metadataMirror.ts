/**
 * What a state transition publishes as external metadata. Pure: whether an
 * action was pending and the transition go in; the updates to publish, in
 * order, and whether an action is pending now come out.
 */
import type {
  RequiresActionDetails,
  SessionExternalMetadata,
  SessionState,
} from 'src/sessions/lifecycle/state/types.js'

type MirroredTransition = {
  updates: SessionExternalMetadata[]
  actionPending: boolean
}

export function mirrorTransition(
  actionPending: boolean,
  state: SessionState,
  details: RequiresActionDetails | undefined,
): MirroredTransition {
  const updates: SessionExternalMetadata[] = []
  let pending = actionPending
  if (state === 'requires_action' && details) {
    // A new blocking request replaces the previous one outright.
    updates.push({ pending_action: details })
    pending = true
  } else if (pending) {
    updates.push({ pending_action: null })
    pending = false
  }
  // A mid-turn summary describes a turn, and an idle session has none running.
  if (state === 'idle') updates.push({ task_summary: null })
  return { updates, actionPending: pending }
}
