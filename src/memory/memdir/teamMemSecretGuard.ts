import { feature } from 'bun:bundle'

import type { SecretMatch } from 'src/memory/memdir/secretScanner.js'

type TeamMemPathsModule = typeof import('src/memory/memdir/teamMemPaths.js')
type SecretScannerModule = typeof import('src/memory/memdir/secretScanner.js')

/** Read back to the model as the tool's error, so it must never quote the content. */
const REFUSAL_REASON =
  'cannot be written to team memory. Team memory is shared with all repository collaborators. Remove the sensitive content and try again.'

function refusalFor(matches: SecretMatch[]): string | null {
  if (matches.length === 0) return null
  const labels = matches.map(match => match.label).join(', ')
  return `Content contains potential secrets (${labels}) and ${REFUSAL_REASON}`
}

/**
 * Called by every file-writing tool, in builds with and without team memory,
 * so the path predicate and the scanner are loaded only on a team build, and
 * only when a write is checked. The auto-memory switch is deliberately not
 * consulted: the team directory is committed whether or not memory is on.
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (feature('TEAMMEM')) {
    const { isTeamMemPath } = require('src/memory/memdir/teamMemPaths.js') as TeamMemPathsModule
    if (!isTeamMemPath(filePath)) return null
    const { scanForSecrets } = require('src/memory/memdir/secretScanner.js') as SecretScannerModule
    return refusalFor(scanForSecrets(content))
  }
  return null
}
