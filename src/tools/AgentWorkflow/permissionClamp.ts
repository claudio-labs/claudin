/**
 * Permission clamp for workflow agents — pure, so it is testable without pulling
 * in the ink-tainted engine. A worker/main agent runs with its own agent-def
 * permission mode, but must never exceed the session's permission context; this
 * returns the *less* permissive of the two.
 */
import type { PermissionMode } from 'src/shared/types/permissions.js'

export const MODE_RANK: Record<string, number> = {
  plan: 0,
  default: 1,
  acceptEdits: 2,
  bypassPermissions: 3,
}

/** Return the *less* permissive of the two modes (agent never exceeds session). */
export function clampMode(
  desired: PermissionMode | undefined,
  session: PermissionMode,
): PermissionMode {
  const s = MODE_RANK[session] ?? 1
  const d = desired !== undefined ? MODE_RANK[desired] : undefined
  // Unknown or absent desired mode → fall back to the session mode rather than
  // forwarding an unranked string that could bypass the clamp.
  if (d === undefined) return session
  return d <= s ? desired! : session
}
