import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'
import { expandPath } from 'src/shared/fs/path.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/**
 * Every spelling of one path the deny, ask and working-directory tests look
 * at: the path, each hop of its link chain, and where it lands (for a path
 * that does not exist yet, where it would land).
 */
export type ResolvedPaths = readonly string[]

type ToolInput = { [key: string]: unknown }

/** One file a check is asked about. */
export type FileTarget = {
  /** The requested path, absolute. Messages and allow rules use it. */
  readonly path: string
  readonly resolved: ResolvedPaths
}

/** What every step of a check gets. */
export type FileCheck = {
  readonly target: FileTarget
  readonly input: ToolInput
  readonly context: ToolPermissionContext
}

/** A step answers with a decision, or null to let the next step decide. */
export type CheckStep = (check: FileCheck) => PermissionDecision | null

export function resolveTarget(requested: string, precomputed?: ResolvedPaths): FileTarget {
  const path = expandPath(requested)
  return { path, resolved: precomputed ?? getPathsForPermissionCheck(path) }
}

export function runSteps(
  check: FileCheck,
  steps: readonly CheckStep[],
  otherwise: (check: FileCheck) => PermissionDecision,
): PermissionDecision {
  for (const step of steps) {
    const decision = step(check)
    if (decision) return decision
  }
  return otherwise(check)
}
