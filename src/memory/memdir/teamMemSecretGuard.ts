import { isTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import { scanForSecrets } from 'src/memory/memdir/secretScanner.js'

/**
 * Check if a file write/edit to a team memory path contains secrets.
 * Returns an error message if secrets are detected, or null if safe.
 *
 * This is called from FileWriteTool and FileEditTool validateInput to
 * prevent the model from writing secrets into team memory files: the team
 * dir is git-tracked, so anything written there reaches every collaborator
 * on the next commit.
 *
 * Callers can import and call this unconditionally — a path outside the team
 * dir returns null before anything is scanned.
 * secretScanner assembles sensitive prefixes at runtime (ANT_KEY_PFX).
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (!isTeamMemPath(filePath)) {
    return null
  }

  const matches = scanForSecrets(content)
  if (matches.length === 0) {
    return null
  }

  const labels = matches.map(m => m.label).join(', ')
  return (
    `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
    'Team memory is shared with all repository collaborators. ' +
    'Remove the sensitive content and try again.'
  )
}
