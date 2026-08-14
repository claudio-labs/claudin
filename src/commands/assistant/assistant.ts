// Stub — assistant command not included in source snapshot
//
// `launchAssistantInstallWizard` (src/dialogLaunchers.tsx) destructures the two
// named exports below from a dynamic import, so they have to exist for the
// caller to type-check. The command itself is gated on `feature('KAIROS')`,
// which is off in this build, so neither is ever reached.
import type * as React from 'react'

export default null

export async function computeDefaultInstallDir(): Promise<string> {
  return ''
}

export function NewInstallWizard(_props: {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.ReactNode {
  return null
}
