import { useEffect, useRef } from 'react'
import {
  type FileHistorySnapshot,
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryRestoreStateFromLog,
} from 'src/shared/fs/fileHistory.js'

/**
 * Hands the REPL, once per mount, the file-history state rebuilt from a
 * resumed session's snapshots. While file history is off it waits: the first
 * run with it on is the one that counts, snapshots or not.
 */
export function useFileHistorySnapshotInit(
  initialFileHistorySnapshots: FileHistorySnapshot[] | undefined,
  fileHistoryState: FileHistoryState,
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  const settled = useRef(false)
  useEffect(() => {
    if (settled.current || !fileHistoryEnabled()) return
    settled.current = true
    if (initialFileHistorySnapshots) fileHistoryRestoreStateFromLog(initialFileHistorySnapshots, onUpdateState)
  }, [initialFileHistorySnapshots, fileHistoryState, onUpdateState])
}
