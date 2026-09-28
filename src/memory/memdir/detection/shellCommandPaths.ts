import { posixPathToWindowsPath } from 'src/shared/fs/windowsPaths.js'
import type { PathPlatform } from 'src/memory/memdir/detection/comparablePath.js'

// Starts at `/` or at a drive letter and separator, and runs until
// whitespace or a quote, so quoted paths come out without their quotes.
const ABSOLUTE_PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s'"]*/g
// Shell punctuation glued to the end of a path; inside a token it stays.
const TRAILING_SHELL_PUNCTUATION_RE = /[,;|&>]+$/
const MINGW_DRIVE_RE = /^\/[A-Za-z](?:\/|$)/

/** The absolute-looking paths a command names, in their native spelling. */
export function absolutePathTokens(
  command: string,
  platform: PathPlatform,
): string[] {
  const tokens: string[] = []
  for (const match of command.match(ABSOLUTE_PATH_TOKEN_RE) ?? []) {
    const token = match.replace(TRAILING_SHELL_PUNCTUATION_RE, '')
    if (token === '') continue
    tokens.push(
      platform === 'windows' && MINGW_DRIVE_RE.test(token)
        ? posixPathToWindowsPath(token)
        : token,
    )
  }
  return tokens
}
