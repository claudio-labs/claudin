// The one place this slice shells out to docker.
//
// Everything above it (the ps snapshot, the events watcher, the Container tool)
// goes through `runDocker`, so the binary is resolved once and the three ways
// docker can be unusable — absent, daemon down, socket not readable — are
// classified once instead of at every call site.
//
// Podman/nerdctl: only the binary name below would change. It is deliberately
// NOT wired up, because nothing here has been tested against them.

import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { logError } from 'src/shared/log.js'
import type { DockerAvailability, DockerUnavailableReason } from 'src/containers/types.js'

const DOCKER_BIN = 'docker'

/** Default ceiling for a read command. Lifecycle and build ops pass their own. */
const DEFAULT_TIMEOUT_MS = 15_000

const DAEMON_DOWN_RE = /cannot connect to the docker daemon|is the docker daemon running/i
const PERMISSION_RE = /permission denied.*docker(?:\.sock)?|dial unix .*permission denied/i
const NOT_INSTALLED_RE = /\benoent\b|not found|no such file or directory|is not recognized/i

export type DockerRunResult = {
  stdout: string
  stderr: string
  code: number
  /** Set when the CLI itself could not be used, as opposed to the command failing. */
  unavailable: DockerUnavailableReason | null
}

export type RunDockerOptions = {
  cwd?: string
  timeout?: number
  abortSignal?: AbortSignal
}

/**
 * Classify a failed invocation. Only consulted on a non-zero exit, so a
 * command whose own output merely mentions the daemon is never misread.
 */
export function classifyDockerFailure(
  stderr: string,
  execError: string | undefined,
): DockerUnavailableReason | null {
  const text = `${execError ?? ''}\n${stderr}`
  if (PERMISSION_RE.test(text)) return 'permission-denied'
  if (DAEMON_DOWN_RE.test(text)) return 'daemon-not-running'
  if (NOT_INSTALLED_RE.test(text)) return 'not-installed'
  return null
}

/** One line the user can act on, for each way docker can be unusable. */
export function describeUnavailable(reason: DockerUnavailableReason): string {
  switch (reason) {
    case 'not-installed':
      return 'docker is not on PATH'
    case 'daemon-not-running':
      return 'the docker daemon is not running'
    case 'permission-denied':
      return 'permission denied on the docker socket — this user is probably not in the `docker` group'
    case 'unknown':
      return 'docker could not be used'
  }
}

export async function runDocker(
  args: string[],
  { cwd, timeout = DEFAULT_TIMEOUT_MS, abortSignal }: RunDockerOptions = {},
): Promise<DockerRunResult> {
  const result = await execFileNoThrowWithCwd(DOCKER_BIN, args, {
    cwd,
    timeout,
    abortSignal,
    preserveOutputOnError: true,
  })
  const unavailable =
    result.code === 0
      ? null
      : classifyDockerFailure(result.stderr, result.error)
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    unavailable,
  }
}

/** The docker binary name, for building the command string a permission check
 * is run against. */
export function dockerBin(): string {
  return DOCKER_BIN
}

let cachedAvailability: DockerAvailability | null = null

/**
 * Probe once per process and remember the answer. A machine does not gain or
 * lose docker mid-session often enough to justify re-probing every tick, and
 * re-probing is exactly what turns a missing daemon into an error per second.
 */
export async function getDockerAvailability(): Promise<DockerAvailability> {
  if (cachedAvailability) return cachedAvailability
  const result = await runDocker(['version', '--format', '{{.Server.Version}}'], {
    timeout: 5_000,
  })
  if (result.code === 0) {
    cachedAvailability = { available: true }
    return cachedAvailability
  }
  const reason = result.unavailable ?? 'unknown'
  if (reason === 'unknown') {
    logError(
      new Error(
        `docker probe failed for an unrecognised reason: ${result.stderr.slice(0, 500)}`,
      ),
    )
  }
  cachedAvailability = {
    available: false,
    reason,
    message: describeUnavailable(reason),
  }
  return cachedAvailability
}

export function __resetDockerAvailabilityForTests(): void {
  cachedAvailability = null
}
