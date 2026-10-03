import {
  CCR_SESSION_INGRESS_TOKEN_PATH,
  maybePersistTokenForSubprocesses,
  readTokenFromWellKnownFile,
} from 'src/providers/auth/authFileDescriptor.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'

const TOKEN_LABEL = 'session ingress token'

/** The two variables that point at an on-disk ingress token. */
export type IngressTokenLocation = {
  /** `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`: an inherited descriptor number. */
  descriptor: string | undefined
  /** `CLAUDE_SESSION_INGRESS_TOKEN_FILE`: overrides the CCR well-known path. */
  tokenFile: string | undefined
}

export type IngressTokenSourceDeps = {
  platform: NodeJS.Platform
  /** Reads a whole file as UTF-8; throws when it cannot be read. */
  readText: (path: string) => string
  /** Trimmed content of a token file, or null when missing, blank or unreadable. */
  readTokenFile: (path: string) => string | null
  /** Leaves a copy for subprocesses that cannot inherit the descriptor (a no-op outside CCR). */
  keepCopyForSubprocesses: (token: string) => void
  debug: (line: string) => void
}

export function defaultIngressTokenSourceDeps(): IngressTokenSourceDeps {
  return {
    platform: process.platform,
    readText: path => getFsImplementation().readFileSync(path, { encoding: 'utf8' }),
    readTokenFile: path => readTokenFromWellKnownFile(path, TOKEN_LABEL),
    // Always the well-known path, even when the token file was overridden for
    // reading: CCR's environment manager owns that layout.
    keepCopyForSubprocesses: token =>
      maybePersistTokenForSubprocesses(CCR_SESSION_INGRESS_TOKEN_PATH, token, TOKEN_LABEL),
    debug: line => logForDebugging(line),
  }
}

function descriptorPath(fd: number, platform: NodeJS.Platform): string {
  const hasDevFd = platform === 'darwin' || platform === 'freebsd'
  return hasDevFd ? `/dev/fd/${fd}` : `/proc/self/fd/${fd}`
}

/**
 * Finds the ingress token a remote container left on disk: the inherited
 * descriptor first, else the token file. Log lines name the descriptor and the
 * path, never the token.
 */
export function readIngressTokenFromDisk(
  where: IngressTokenLocation,
  deps: IngressTokenSourceDeps,
): string | null {
  const fallbackFile = where.tokenFile || CCR_SESSION_INGRESS_TOKEN_PATH
  if (!where.descriptor) return deps.readTokenFile(fallbackFile)

  const fd = Number.parseInt(where.descriptor, 10)
  // A malformed variable is a launcher bug; guessing a file instead would hide it.
  if (Number.isNaN(fd)) {
    deps.debug(`Ingress token descriptor variable is not a number: ${where.descriptor}`)
    return null
  }

  let content: string
  try {
    content = deps.readText(descriptorPath(fd, deps.platform))
  } catch (error) {
    // Typical of a subprocess that inherited the variable but not the descriptor.
    deps.debug(`Ingress token descriptor ${fd} unreadable (${errorMessage(error)}); trying ${fallbackFile}`)
    return deps.readTokenFile(fallbackFile)
  }

  const token = content.trim()
  if (token === '') {
    deps.debug(`Ingress token descriptor ${fd} was empty`)
    return null
  }
  deps.debug(`Ingress token read from descriptor ${fd}`)
  deps.keepCopyForSubprocesses(token)
  return token
}
