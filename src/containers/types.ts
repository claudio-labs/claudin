// Shared shapes for the container slice: what a container looks like once
// `docker ps` output has been parsed, independent of how it was obtained.
//
// Kept free of React and of `src/tools/` imports so both the TUI hook and the
// Container tool can depend on it without a cycle.

/** Docker's own container states, as reported by `docker ps --format '{{json .}}'`. */
export type ContainerState =
  | 'created'
  | 'restarting'
  | 'running'
  | 'removing'
  | 'paused'
  | 'exited'
  | 'dead'

/**
 * Healthcheck verdict. `none` means the image declares no healthcheck at all —
 * a distinct answer from "not healthy", and the reason `wait until healthy`
 * must fail fast instead of hanging.
 */
export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none'

/** One published port mapping, host side first. */
export type ContainerPort = {
  /** Host port, or null for an exposed-but-unpublished port. */
  hostPort: number | null
  containerPort: number
  protocol: string
}

export type ContainerInfo = {
  /** Full container ID. Reconcile keys on this, never on the name — compose
   * recreates a service under the same name with a new ID. */
  id: string
  /** `legendarr-legendarr-1`. */
  name: string
  image: string
  state: ContainerState
  /** Docker's raw `Status` column, kept verbatim for diagnostics:
   * `Up 2 hours (healthy)`, `Exited (137) 3 minutes ago`, `Restarting (1) 2 seconds ago`. */
  status: string
  health: ContainerHealth
  /** Exit code parsed out of `Exited (N)` / `Restarting (N)`, else null. */
  exitCode: number | null
  ports: ContainerPort[]
  /** `com.docker.compose.project`, or null for a plain `docker run` container. */
  project: string | null
  /** `com.docker.compose.service`. Several replicas share one service. */
  service: string | null
  /** `com.docker.compose.project.working_dir` — the directory the stack was
   * brought up from, which is what scopes the panel to the current project. */
  workingDir: string | null
  /** Epoch ms, or null when docker's timestamp could not be parsed. */
  createdAt: number | null
}

/** Why the docker CLI could not be used, when it could not. */
export type DockerUnavailableReason =
  | 'not-installed'
  | 'daemon-not-running'
  | 'permission-denied'
  | 'unknown'

export type DockerUnavailable = {
  available: false
  reason: DockerUnavailableReason
  /** One line, already human-readable, safe to show in the TUI. */
  message: string
}

export type DockerAvailable = { available: true }

export type DockerAvailability = DockerAvailable | DockerUnavailable
