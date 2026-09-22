import { feature } from 'bun:bundle'

/**
 * Check if a file write/edit to a team memory path contains secrets.
 * Returns an error message if secrets are detected, or null if safe.
 *
 * This is called from FileWriteTool and FileEditTool validateInput to
 * prevent the model from writing secrets into team memory files: the team
 * dir is git-tracked, so anything written there reaches every collaborator
 * on the next commit.
 *
 * Callers can import and call this unconditionally — the internal
 * feature('TEAMMEM') guard keeps it inert when the build flag is off.
 * secretScanner assembles sensitive prefixes at runtime (ANT_KEY_PFX).
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (feature('TEAMMEM')) {
    // Typed via annotation rather than `as`: knip only recognises a named
    // require when the call is the declaration's direct initializer, and the
    // HTTP sync that used to import scanForSecrets statically is gone.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      isTeamMemPath,
    }: typeof import('src/memory/memdir/teamMemPaths.js') = require('src/memory/memdir/teamMemPaths.js')
    const {
      scanForSecrets,
    }: typeof import('src/memory/memdir/secretScanner.js') = require('src/memory/memdir/secretScanner.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

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
  return null
}
