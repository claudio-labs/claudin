// Input and result shapes for the Container tool.
//
// Kept apart from ContainerTool.ts so the pure command builder, the runner and
// the permission check can share one definition of an op without importing the
// tool (and, through it, the whole tool registry).

import type { ContainerInfo } from 'src/containers/types.js'
import type { Diagnosis } from 'src/containers/diagnostics/classify.js'
import type { LogExtraction } from 'src/containers/diagnostics/extractLogErrors.js'
import type { BuildKitSummary } from 'src/containers/build/parseBuildKit.js'

/**
 * The op catalog, grouped by what the op does to the machine. The grouping is
 * load-bearing twice over: `MUTATING_OPS` decides which ops go through the
 * permission pipeline, and `ALWAYS_ASK_OPS` decides which can never be
 * auto-allowed.
 */

/** Read-only: reports what docker already knows. */
export const READ_OPS = [
  'ps',
  'inspect',
  'logs',
  'stats',
  'top',
  'port',
  'images',
  'df',
  'config',
  'events',
] as const

/** Lifecycle: starts, stops and moves containers. */
export const LIFECYCLE_OPS = [
  'up',
  'down',
  'start',
  'stop',
  'restart',
  'pause',
  'unpause',
  'pull',
  'push',
] as const

/** Images and builds. */
export const IMAGE_OPS = ['build', 'tag', 'history'] as const

/** Runs a command of the caller's choosing. */
export const INTERACT_OPS = ['exec', 'run', 'cp'] as const

/** Blocks until a container reaches a state. */
export const WAIT_OPS = ['wait'] as const

/** Removes things. Never auto-allowed. */
export const DESTRUCTIVE_OPS = ['rm', 'rmi', 'prune'] as const

export const CONTAINER_OPS = [
  ...READ_OPS,
  ...LIFECYCLE_OPS,
  ...IMAGE_OPS,
  ...INTERACT_OPS,
  ...WAIT_OPS,
  ...DESTRUCTIVE_OPS,
] as const

export type ContainerOp = (typeof CONTAINER_OPS)[number]

const READ_SET: ReadonlySet<string> = new Set(READ_OPS)
const DESTRUCTIVE_SET: ReadonlySet<string> = new Set(DESTRUCTIVE_OPS)

/** `wait` only observes, so it is read-only even though it is not in READ_OPS. */
export function isReadOnlyOp(op: ContainerOp): boolean {
  return READ_SET.has(op) || op === 'wait'
}

/**
 * Flags that make an otherwise ordinary op delete data, keyed by the op they
 * belong to. Keyed rather than global because the same letter means different
 * things per op: `-v` is a bind mount on `run` and a volume wipe on `down`.
 */
const DESTRUCTIVE_FLAGS: Partial<Record<ContainerOp, ReadonlySet<string>>> = {
  down: new Set(['-v', '--volumes', '--rmi']),
  up: new Set(['-V', '--renew-anon-volumes']),
}

/** One argv token as the flags it carries: `--rmi=all` → `--rmi`, `-tv` → `-t`, `-v`. */
function flagsIn(token: string): string[] {
  if (!token.startsWith('-')) return []
  const name = token.split('=')[0] ?? ''
  if (name.startsWith('--')) return [name]
  return [...name.slice(1)].map(char => `-${char}`)
}

/**
 * Whether this command must reach the permission dialog whatever the user's
 * rules say.
 *
 * It reads the BUILT argv rather than the input fields, and that is the whole
 * point: `args` is appended verbatim by `buildContainerCommand`, so
 * `{op:'down', args:['-v']}` produces byte-for-byte the same volume wipe as
 * `{op:'down', volumes:true}`. A check that read only `volumes` let the first
 * form through an always-allow rule with no dialog at all.
 */
export function isAlwaysAskCommand(
  op: ContainerOp,
  argv: readonly string[],
): boolean {
  if (DESTRUCTIVE_SET.has(op)) return true
  const flags = DESTRUCTIVE_FLAGS[op]
  if (!flags) return false
  return argv.some(token => flagsIn(token).some(flag => flags.has(flag)))
}

export type WaitUntil = 'healthy' | 'running' | 'exited'
export type PruneTarget = 'image' | 'volume' | 'system' | 'container'

export type ContainerToolInput = {
  op: ContainerOp
  /** Compose service, or a container name/id for container-scoped ops. */
  service?: string
  /** Path to a compose file. Makes an op compose-scoped when the op supports it. */
  composeFile?: string
  /** Extra argv, passed as separate entries — never joined into a shell string. */
  args?: string[]
  /** `logs` window, e.g. `10m`. Defaulted rather than left unbounded. */
  since?: string
  /** `logs` line cap. */
  tail?: number
  /** Stream `logs` as a background monitor task. */
  follow?: boolean
  /** `wait` target state. */
  until?: WaitUntil
  /** Wall ceiling in ms. */
  timeout?: number
  /** How long the op may produce NO output at all before it is stopped. Only
   * meaningful for the streamed ops (`build`, `up`); everything else is
   * buffered and answers in one shot. */
  idleTimeout?: number
  /** Run `build` as a background monitor task. */
  background?: boolean
  /** `down --volumes`. Destructive: always reaches the dialog. */
  volumes?: boolean
  /** Project root override. A worktree sub-agent has a different cwd. */
  directory?: string
  /** `ps --all` / `images --all`. */
  all?: boolean
  /** Command for `exec` and `run`, as argv. */
  command?: string[]
  /** Input piped to `exec`'s stdin. Its presence is what adds `-i`. */
  stdin?: string
  /** `cp` endpoints. */
  source?: string
  dest?: string
  /** `prune` target. */
  target?: PruneTarget
}

/** What `buildContainerCommand` produces. */
export type BuiltCommand = {
  /** argv after the binary — `['compose', '-f', 'x.yml', 'up', '-d']`. */
  argv: string[]
  /** The same command as one shell string, for the permission check ONLY.
   * Nothing executes this; `argv` is what runs. */
  commandString: string
  kind: 'compose' | 'docker'
}

export type ContainerStall = {
  reason: 'ceiling' | 'idle'
  ranMs: number
  silentMs: number
  /** Last line the command printed before it went quiet. */
  lastLine: string
}

/**
 * What the live tool block shows while a build runs. Declared here rather than
 * in `src/shared/types/tools.ts` for the same reason BuildProgress is, and
 * pulled into the `ToolProgressData` union from there.
 *
 * Never reaches the model — `normalizeMessagesForAPI` drops every `progress`
 * message before serialization, so this costs nothing in tokens.
 */
export type ContainerProgress = {
  type: 'container_progress'
  /** The current BuildKit step, already reduced to one line. Empty until the
   * build prints its first record. */
  label: string
  elapsedMs: number
}
// No `silentMs` here on purpose. The streaming path measures it and acts on it
// (that is the idle watchdog), but it is not carried across this seam, and a
// field that would always arrive 0 is worse than an absent one — it reads as a
// measurement.

/** One container as the `ps` op reports it, with whatever is wrong with it. */
export type ContainerRow = {
  container: ContainerInfo
  diagnosis: Diagnosis | null
}

export type ContainerToolOutput = {
  op: ContainerOp
  /** The command that ran, for the UI and for the model's benefit. */
  command: string
  exitCode: number
  /** Already-shaped body. A FAILURE is never shaped — see run.ts. */
  output: string
  /** One-line verdict prepended to a failure's raw text. */
  diagnosis: Diagnosis | null
  /** Set when the filter pipeline actually reduced the body. */
  filtered?: { name: string; reductionPct: number }
  /** `ps` only. */
  rows?: ContainerRow[]
  /** `logs` only. */
  logs?: LogExtraction
  /** `build` only. */
  build?: BuildKitSummary
  /** `build` only: the context transfer dominated, so `.dockerignore` is
   * probably missing. */
  contextWarning?: string
  /** `wait` only. */
  wait?: {
    satisfied: boolean
    observedState: string
    observedHealth: string
    waitedMs: number
    /** Why the wait can never succeed, when it cannot. */
    impossible?: string
  }
  /** Set when the op was backgrounded. */
  backgroundTaskId?: string
  /** Reported as an observation, never diagnosed as a hang. */
  stall?: ContainerStall
  durationMs: number
}
