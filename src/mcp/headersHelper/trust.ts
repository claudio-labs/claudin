/**
 * Whether a headersHelper may run before workspace trust. Project and local
 * servers come from files in the workspace, so in an interactive session
 * their helper waits for the trust dialog. A non-interactive session never
 * shows that dialog and runs them as it runs hooks (spec Findings 1 and 2:
 * kept, tracked with project server approval).
 */

export type HelperTrustDecision = 'run' | 'refuse'

const WORKSPACE_SCOPES: ReadonlySet<string> = new Set(['project', 'local'])

export function decideHelperTrust(
  scope: string | undefined,
  interactive: boolean,
  isWorkspaceTrusted: () => boolean,
): HelperTrustDecision {
  if (!interactive) return 'run'
  if (scope === undefined || !WORKSPACE_SCOPES.has(scope)) return 'run'
  return isWorkspaceTrusted() ? 'run' : 'refuse'
}
