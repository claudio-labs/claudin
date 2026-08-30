// Failures-first classification for containers and for docker command output.
//
// Two pure entry points, no I/O:
//   - `classifyContainer` reads a parsed `docker ps` row (plus, optionally, the
//     two facts only `docker inspect` can supply) and says what is wrong.
//   - `classifyCommandFailure` reads the text a failed docker/compose/build
//     command printed and says why it failed.
//
// The point is that a broken container comes back diagnosed in ONE call: the
// caller should never have to follow up with `docker inspect` to learn that a
// 137 was the OOM killer, or re-read the log to find which step of a build
// actually failed.

import {
  classifyDockerFailure,
  describeUnavailable,
} from 'src/containers/docker/dockerCli.js'
import type { ContainerInfo } from 'src/containers/types.js'

export type DiagnosisKind =
  // container state
  | 'exit-signal'
  | 'exit-error'
  | 'oom-killed'
  | 'crash-loop'
  | 'unhealthy'
  | 'no-healthcheck'
  | 'paused'
  | 'dead'
  // startup / compose
  | 'port-conflict'
  | 'image-pull-denied'
  | 'image-not-found'
  | 'registry-rate-limited'
  | 'unset-variable'
  | 'mount-failed'
  | 'dependency-unhealthy'
  | 'no-such-service'
  | 'compose-file-error'
  // environment
  | 'daemon-not-running'
  | 'permission-denied'
  | 'not-installed'
  | 'no-space-left'
  // build
  | 'build-no-space'
  | 'build-network'
  | 'build-copy-missing'
  | 'build-secret-missing'
  | 'build-builder-missing'

export type Diagnosis = {
  kind: DiagnosisKind
  /** One line, present tense, no trailing period. */
  summary: string
  /** The docker line that produced this verdict. Empty when the verdict came
   * from structured state rather than from text. */
  evidence: string
}

/** Where the output came from. Only used to disambiguate the handful of
 * messages that read identically during a build and at run time. */
export type FailureContext = 'build' | 'run'

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** The codes worth naming. Anything else in the 128+N range is reported as
 * "signal N" rather than guessed at. */
const SIGNAL_NAMES: ReadonlyMap<number, string> = new Map([
  [2, 'SIGINT'],
  [6, 'SIGABRT'],
  [9, 'SIGKILL'],
  [11, 'SIGSEGV'],
  [15, 'SIGTERM'],
])

const SIGNAL_EXIT_BASE = 128
/** POSIX signal numbers stop well before this; 128+64 is the top of the range. */
const MAX_SIGNAL = 64

/**
 * Decode a container exit code into a signal name when it is one.
 *
 * `docker ps` reports a signalled process as 128+N, so 137 is SIGKILL and 143
 * is SIGTERM. It does NOT distinguish "the OOM killer sent SIGKILL" from "a
 * human ran docker kill" — that needs `.State.OOMKilled`, which is why
 * `classifyContainer` takes it as a separate input.
 */
export function decodeSignal(exitCode: number): string | null {
  if (exitCode <= SIGNAL_EXIT_BASE) return null
  const signal = exitCode - SIGNAL_EXIT_BASE
  if (signal > MAX_SIGNAL) return null
  return SIGNAL_NAMES.get(signal) ?? `signal ${signal}`
}

// ---------------------------------------------------------------------------
// Container state
// ---------------------------------------------------------------------------

/** A container that has bounced this many times is looping, not recovering. */
export const CRASH_LOOP_RESTART_THRESHOLD = 3

export type ClassifyContainerOptions = {
  /**
   * `.State.OOMKilled` from `docker inspect`. When true, a 137 is reported as
   * an OOM kill instead of a bare SIGKILL — the single most misread thing in
   * docker. Absent means "not known", never "not OOM".
   */
  oomKilled?: boolean
  /** `.RestartCount` from `docker inspect`. */
  restartCount?: number
  /** Memory limit in bytes, if known, to put in the OOM summary. */
  memoryLimitBytes?: number
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`
  return `${bytes}B`
}

/**
 * What is wrong with this container, or null when nothing is.
 *
 * A healthy running container is not a diagnosis, and neither is a clean
 * `Exited (0)` — a batch container that finished is doing its job.
 */
export function classifyContainer(
  container: ContainerInfo,
  opts: ClassifyContainerOptions = {},
): Diagnosis | null {
  const { name, state, status, health, exitCode } = container

  // Restarting is checked before the exit code: a container in a crash loop
  // also carries the exit code of its last death, and the loop is the story.
  if (state === 'restarting') {
    const count = opts.restartCount
    if (count !== undefined && count >= CRASH_LOOP_RESTART_THRESHOLD) {
      const code =
        exitCode !== null ? `, last exit ${exitCode}` : ''
      return {
        kind: 'crash-loop',
        summary: `${name} is restarting in a loop — ${count} restarts${code}`,
        evidence: status,
      }
    }
    return {
      kind: 'crash-loop',
      summary: `${name} is restarting`,
      evidence: status,
    }
  }

  if (state === 'paused') {
    // Worth its own verdict: `docker ps` still shows it under Up, so it reads
    // as running while serving nothing.
    return {
      kind: 'paused',
      summary: `${name} is paused — it is not serving requests`,
      evidence: status,
    }
  }

  if (state === 'dead') {
    return {
      kind: 'dead',
      summary: `${name} is dead — the daemon could not remove it cleanly`,
      evidence: status,
    }
  }

  if (state === 'exited' && exitCode !== null && exitCode !== 0) {
    if (opts.oomKilled === true) {
      const limit =
        opts.memoryLimitBytes !== undefined
          ? ` (limit ${formatBytes(opts.memoryLimitBytes)})`
          : ''
      return {
        kind: 'oom-killed',
        summary: `${name} was killed by the OOM killer${limit}`,
        evidence: status,
      }
    }
    const signal = decodeSignal(exitCode)
    if (signal) {
      return {
        kind: 'exit-signal',
        summary: `${name} was killed by ${signal} (exit ${exitCode})`,
        evidence: status,
      }
    }
    return {
      kind: 'exit-error',
      summary: `${name} exited with code ${exitCode}`,
      evidence: status,
    }
  }

  if (health === 'unhealthy') {
    return {
      kind: 'unhealthy',
      summary: `${name} is unhealthy`,
      evidence: status,
    }
  }

  return null
}

/**
 * Whether a container can ever satisfy "wait until healthy".
 *
 * Deliberately NOT part of `classifyContainer`: most images declare no
 * healthcheck at all, so firing a diagnosis for it would flag every normal
 * container. It only becomes a failure when a caller explicitly asked to wait
 * for health, which is the one place that calls this.
 */
export function diagnoseNoHealthcheck(
  container: ContainerInfo,
): Diagnosis | null {
  if (container.health !== 'none') return null
  return {
    kind: 'no-healthcheck',
    summary: `${container.name} declares no healthcheck, so it can never report healthy`,
    evidence: container.status,
  }
}

// ---------------------------------------------------------------------------
// Command output
// ---------------------------------------------------------------------------

const PORT_CONFLICT_RE =
  /address already in use|port is already allocated|bind: address already in use/i
/** Pull the host port out of whichever shape the daemon used to report it. */
const PORT_NUMBER_RE =
  /failed to bind host port for [^\s:]+:(\d+)|Bind for [^\s:]+:(\d+) failed|listen tcp [^\s:]+:(\d+):/i

const RATE_LIMIT_RE = /toomanyrequests|pull rate limit/i
const PULL_DENIED_RE =
  /pull access denied|denied: requested access to the resource is denied|authentication required/i
const IMAGE_NOT_FOUND_RE =
  /manifest unknown|manifest for .+ not found|repository .+ not found/i

const DEPENDENCY_UNHEALTHY_RE =
  /dependency failed to start: container (\S+) is unhealthy/i
const NO_SUCH_SERVICE_RE =
  /no such service:\s*(\S+)|service "([^"]+)" is not defined/i
const COMPOSE_FILE_ERROR_RE =
  /^yaml: |validating .*compose.*:|services\.\S+ Additional property|is invalid: /im
const UNSET_VARIABLE_RE =
  /variable is not set\. Defaulting to a blank string/i
const MOUNT_FAILED_RE =
  /error while creating mount source path|invalid mount config|bind source path does not exist|are you trying to mount a directory onto a file/i

const NO_SPACE_RE = /no space left on device/i

const BUILD_COPY_MISSING_RE =
  /failed to compute cache key|failed to calculate checksum of ref .*?: "([^"]+)": not found/i
const BUILD_SECRET_MISSING_RE =
  /secret \S+ not found|missing required secret|failed to (?:get|read) secret|unable to prepare context: .*ssh/i
const BUILD_BUILDER_MISSING_RE =
  /no builder "?[\w-]+"? found|failed to find driver|ERROR: no builder/i
const BUILD_NETWORK_RE =
  /Temporary failure resolving|Could not resolve host|E: Failed to fetch|Could not connect to \S+ \(.*\), connection timed out|network is unreachable|ETIMEDOUT|ENOTFOUND registry\.npmjs\.org/i

/** Which capture group holds the copy path, when the checksum shape matched. */
const COPY_PATH_RE = /"([^"]+)": not found/i
/** Evidence line for an environment verdict — the message always names docker. */
const DOCKER_MENTION_RE = /docker/i

/** First line of `text` matching `re`, trimmed. Empty when nothing matched —
 * evidence is a nicety, never a reason to fail the classification. */
function evidenceFor(text: string, re: RegExp): string {
  for (const line of text.split('\n')) {
    if (re.test(line)) return line.trim()
  }
  return ''
}

function firstGroup(m: RegExpExecArray): string | null {
  for (let i = 1; i < m.length; i++) {
    const g = m[i]
    if (g) return g
  }
  return null
}

export type ClassifyCommandFailureOptions = {
  /** Anything the command wrote to stdout, appended to stderr before matching.
   * `docker compose` writes most of its progress and several of its errors
   * there, so a stderr-only match misses them. */
  stdout?: string
  /** `build` maps the shared "no space left" message to its build-specific
   * verdict; everything else is distinctive on its own. */
  context?: FailureContext
}

/**
 * Why a docker/compose/build command failed.
 *
 * Order is load-bearing and explicit: the build-specific and registry patterns
 * run BEFORE the generic environment check, because `classifyDockerFailure`'s
 * `not found` arm is broad enough to swallow `manifest unknown ... not found`
 * and report a missing docker binary instead of a missing image.
 */
export function classifyCommandFailure(
  stderr: string,
  opts: ClassifyCommandFailureOptions = {},
): Diagnosis | null {
  const text = opts.stdout ? `${stderr}\n${opts.stdout}` : stderr
  if (!text.trim()) return null
  const isBuild = opts.context === 'build'

  // 1. Build-step failures. Most specific: they name a path or a resource.
  const copyMatch = BUILD_COPY_MISSING_RE.exec(text)
  if (copyMatch) {
    const path = COPY_PATH_RE.exec(text)?.[1]
    return {
      kind: 'build-copy-missing',
      summary: path
        ? `COPY source ${path} is not in the build context`
        : 'a COPY source is not in the build context',
      evidence: evidenceFor(text, BUILD_COPY_MISSING_RE),
    }
  }
  if (BUILD_SECRET_MISSING_RE.test(text)) {
    return {
      kind: 'build-secret-missing',
      summary: 'the build needs a --secret or --ssh mount that was not provided',
      evidence: evidenceFor(text, BUILD_SECRET_MISSING_RE),
    }
  }
  if (BUILD_BUILDER_MISSING_RE.test(text)) {
    return {
      kind: 'build-builder-missing',
      summary: 'the buildx builder is missing or not running',
      evidence: evidenceFor(text, BUILD_BUILDER_MISSING_RE),
    }
  }
  if (BUILD_NETWORK_RE.test(text)) {
    return {
      kind: 'build-network',
      summary: 'a package download inside the build could not reach the network',
      evidence: evidenceFor(text, BUILD_NETWORK_RE),
    }
  }

  // 2. Registry. `rate limited` before `denied`: a throttled pull also prints
  // an access-denied line, and the rate limit is the actionable half.
  if (RATE_LIMIT_RE.test(text)) {
    return {
      kind: 'registry-rate-limited',
      summary: 'the registry is rate-limiting this pull',
      evidence: evidenceFor(text, RATE_LIMIT_RE),
    }
  }
  if (PULL_DENIED_RE.test(text)) {
    return {
      kind: 'image-pull-denied',
      summary: 'pull access denied — the image is private or the login expired',
      evidence: evidenceFor(text, PULL_DENIED_RE),
    }
  }
  if (IMAGE_NOT_FOUND_RE.test(text)) {
    return {
      kind: 'image-not-found',
      summary: 'the image or tag does not exist in the registry',
      evidence: evidenceFor(text, IMAGE_NOT_FOUND_RE),
    }
  }

  // 3. Startup.
  if (PORT_CONFLICT_RE.test(text)) {
    const portMatch = PORT_NUMBER_RE.exec(text)
    const port = portMatch ? firstGroup(portMatch) : null
    return {
      kind: 'port-conflict',
      summary: port
        ? `host port ${port} is already in use`
        : 'a published host port is already in use',
      evidence: evidenceFor(text, PORT_CONFLICT_RE),
    }
  }
  const depMatch = DEPENDENCY_UNHEALTHY_RE.exec(text)
  if (depMatch) {
    // Name the DEPENDENCY: compose reports the failure against the service
    // that refused to start, which is not the one that needs fixing.
    return {
      kind: 'dependency-unhealthy',
      summary: `the dependency ${depMatch[1]} never became healthy`,
      evidence: evidenceFor(text, DEPENDENCY_UNHEALTHY_RE),
    }
  }
  const serviceMatch = NO_SUCH_SERVICE_RE.exec(text)
  if (serviceMatch) {
    const service = firstGroup(serviceMatch)
    return {
      kind: 'no-such-service',
      summary: service
        ? `no service named ${service} in this compose file`
        : 'no such service in this compose file',
      evidence: evidenceFor(text, NO_SUCH_SERVICE_RE),
    }
  }
  if (MOUNT_FAILED_RE.test(text)) {
    return {
      kind: 'mount-failed',
      summary: 'a volume or bind mount could not be created',
      evidence: evidenceFor(text, MOUNT_FAILED_RE),
    }
  }
  if (COMPOSE_FILE_ERROR_RE.test(text)) {
    return {
      kind: 'compose-file-error',
      summary: 'the compose file is not valid',
      evidence: evidenceFor(text, COMPOSE_FILE_ERROR_RE),
    }
  }
  if (UNSET_VARIABLE_RE.test(text)) {
    // Last of the compose group on purpose: it is a warning that accompanies a
    // real failure at least as often as it is the failure.
    return {
      kind: 'unset-variable',
      summary: 'a compose variable is unset and defaulted to an empty string',
      evidence: evidenceFor(text, UNSET_VARIABLE_RE),
    }
  }

  // 4. Disk, which reads identically in both contexts.
  if (NO_SPACE_RE.test(text)) {
    return {
      kind: isBuild ? 'build-no-space' : 'no-space-left',
      summary: isBuild
        ? 'the build ran out of disk space'
        : 'the host is out of disk space',
      evidence: evidenceFor(text, NO_SPACE_RE),
    }
  }

  // 5. Environment, last: its `not found` arm is broad by design and would
  // otherwise claim every missing image as a missing docker binary.
  const unavailable = classifyDockerFailure(text, undefined)
  if (unavailable && unavailable !== 'unknown') {
    return {
      kind: unavailable,
      summary: describeUnavailable(unavailable),
      evidence: evidenceFor(text, DOCKER_MENTION_RE),
    }
  }

  return null
}
