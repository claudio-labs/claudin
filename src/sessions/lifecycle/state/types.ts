export type SessionState = 'idle' | 'running' | 'requires_action'

/** What a session blocked on the user is waiting for. */
export type RequiresActionDetails = {
  tool_name: string
  action_description: string
  tool_use_id: string
  request_id: string
  input?: Record<string, unknown>
}

/** Session facts published to the remote host, which keeps the last value of each. */
export type SessionExternalMetadata = {
  permission_mode?: string | null
  model?: string | null
  pending_action?: RequiresActionDetails | null
  // `unknown` on purpose: the SDK declarations re-export this type, and a
  // concrete type here would pull its import path in with it.
  post_turn_summary?: unknown
  task_summary?: string | null
}
