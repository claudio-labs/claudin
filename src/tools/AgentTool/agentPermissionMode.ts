import { feature } from 'bun:bundle'

import type { PermissionMode } from 'src/shared/types/permissions.js'

/**
 * Parent modes a sub-agent's own `permissionMode` must never override.
 *
 * `bypassPermissions` and `acceptEdits` are the user's explicit "let it run"
 * choices, so an agent definition does not get to walk them back.
 *
 * `plan` is here for the opposite reason. The plan-mode gate
 * (`planModeHardDenyIfApplicable` in src/permissions/permissions.ts) reads the
 * mode off the context the CHILD sees, so a child running under its own mode
 * is not gated at all: a fork spawned mid-plan could Edit, Write and run a
 * mutating Bash while the session was still planning. The fork definition
 * declares `permissionMode: 'bubble'` (forkSubagent.ts) purely to route its
 * prompts to the parent terminal — that routing reads the definition, not the
 * resolved mode, so keeping the parent's `plan` here costs it nothing.
 */
const PARENT_MODE_WINS: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'bypassPermissions',
  'acceptEdits',
  'plan',
])

/**
 * The permission mode a sub-agent runs under: its own when it declares one,
 * the parent's when the parent's mode wins.
 */
export function resolveAgentPermissionMode(
  parentMode: PermissionMode,
  agentPermissionMode: PermissionMode | undefined,
): PermissionMode {
  if (!agentPermissionMode) return parentMode
  if (PARENT_MODE_WINS.has(parentMode)) return parentMode
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (parentMode === 'auto') return parentMode
  }
  return agentPermissionMode
}
