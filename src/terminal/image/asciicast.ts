// External build: terminal recording is not available.
// Keep this module as a stable no-op surface so runtime imports stay valid.


export function getSessionRecordingPaths(): string[] {
  return []
}

export async function renameRecordingForSession(): Promise<void> {}


