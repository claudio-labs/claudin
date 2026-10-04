import { useSyncExternalStore } from 'react'
import {
  isClassifierChecking,
  subscribeClassifierChecking,
} from 'src/permissions/classifierApprovals.js'

/** Re-renders whenever a check starts or ends, with whether this tool use is being checked. */
export function useIsClassifierChecking(toolUseID: string): boolean {
  const snapshot = (): boolean => isClassifierChecking(toolUseID)
  return useSyncExternalStore(subscribeClassifierChecking, snapshot, snapshot)
}
