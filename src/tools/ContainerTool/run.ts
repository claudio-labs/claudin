// Execution for every Container op.
//
// Three contracts hold across all of them, and each has a test:
//
//  - A FAILURE is never budgeted, summarized or elided. It comes back as raw
//    text with a one-line diagnosis prepended, mirroring GitTool's error
//    branch. Summarizing is for successful, noisy output.
//  - A successful noisy body is shaped through the EXISTING Bash container
//    filter specs, and kept only when it actually reduced the body. No new
//    filters are written here.
//  - Nothing reads `process.cwd()`. The project root arrives from the caller,
//    so a sub-agent running inside a worktree reports its own containers rather
//    than the parent's.

import { spawnShellTask } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'
import { exec } from 'src/shared/proc/Shell.js'
import { logError } from 'src/shared/log.js'
import { runDocker } from 'src/containers/docker/dockerCli.js'
import { snapshotProjectContainers } from 'src/containers/docker/eventsWatcher.js'
import { markContainersStartedByUs } from 'src/containers/startedByUs.js'
import {
  classifyCommandFailure,
  classifyContainer,
  diagnoseNoHealthcheck,
  type Diagnosis,
} from 'src/containers/diagnostics/classify.js'
import { extractLogErrors } from 'src/containers/diagnostics/extractLogErrors.js'
import {
  parseBuildKit,
  type BuildKitSummary,
} from 'src/containers/build/parseBuildKit.js'
import type { ContainerInfo } from 'src/containers/types.js'
import { findFilterForCommand } from 'src/tools/shared/outputFilter/Bash/registry.js'
import { applyPipeline } from 'src/tools/shared/outputFilter/Bash/pipeline.js'
import {
  buildContainerCommand,
  type BuildCommandContext,
} from 'src/tools/ContainerTool/buildCommand.js'
import { runStreamingDocker } from 'src/tools/ContainerTool/buildProgress.js'
import {
  isReadOnlyOp,
  type BuiltCommand,
  type ContainerOp,
  type ContainerRow,
  type ContainerToolInput,
  type ContainerToolOutput,
  type WaitUntil,
} from 'src/tools/ContainerTool/types.js'

/** Wall ceiling for a long op. Matches BuildTool's. */
export const DEFAULT_WALL_TIMEOUT_MS = 600_000
/** A stretch with NO output at all. A long `RUN apt-get` is legitimately quiet,
 * so this is reported as an observation, never diagnosed as a hang. */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000
/** Read ops answer immediately or something is wrong. */
export const READ_TIMEOUT_MS = 30_000
/** How often `wait` re-snapshots. */
export const WAIT_POLL_MS = 1_000
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000

/** A summary is only worth its marker when it is meaningfully smaller. Same
 * threshold GitTool and the Bash filter use. */
const SUMMARY_MAX_RATIO = 0.7

/** A build whose context transfer is at least this large is almost always a
 * missing `.dockerignore` rather than a genuinely big project. */
const FAT_CONTEXT_BYTES = 100 * 1024 * 1024

/** Ops that legitimately take minutes. */
const LONG_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>([
  'build',
  'up',
  'pull',
  'push',
  'down',
])

/** Ops after which containers may have become live, and are therefore ours. */
const STARTING_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>([
  'up',
  'start',
  'restart',
])

/**
 * Ops that go through the STREAMING path rather than `runDocker`.
 *
 * These are the two that can run for minutes, and the two whose value depends
 * on being watched while they do: without a stream there is no live label and
 * nothing to measure silence against. `up` is included unconditionally because
 * whether it will build or pull cannot be known before it runs, and streaming
 * a fast `up` costs nothing.
 */
const STREAMING_OPS: ReadonlySet<ContainerOp> = new Set<ContainerOp>([
  'build',
  'up',
])

export type RunContainerOpOptions = {
  /** Project root. Never defaulted from `process.cwd()` here. */
  cwd: string
  abortSignal?: AbortSignal
  /** Live label for the TUI. Dropped before serialization, so it costs the
   * model nothing. */
  onProgress?: (label: string) => void
  toolUseId?: string
  /** Compose file discovered for the project. */
  composeFile?: string
  /** Task spawn plumbing, needed only for a backgrounded build. */
  spawn?: {
    abortController: AbortController
    setAppState: (updater: (prev: never) => never) => void
    agentId?: string
  }
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`
  return `${bytes}B`
}

/**
 * Shape a successful body through the existing Bash container filters.
 *
 * Returns the original when no filter matches or the summary did not earn its
 * place — the ≤70% rule. Never applied to a failure.
 */
export function shapeOutput(
  commandString: string,
  raw: string,
): { body: string; filtered?: { name: string; reductionPct: number } } {
  if (!raw.trim()) return { body: raw }
  const filter = findFilterForCommand(commandString)
  if (!filter) return { body: raw }
  try {
    const result = applyPipeline(filter, raw)
    if (result.body.length > raw.length * SUMMARY_MAX_RATIO) {
      return { body: raw }
    }
    return {
      body: result.body,
      filtered: { name: filter.name, reductionPct: result.reductionPct },
    }
  } catch (e) {
    // Fallback pattern: a filter failure returns the raw result unchanged
    // rather than blocking the caller.
    logError(new Error('container output filter failed', { cause: e }))
    return { body: raw }
  }
}

function timeoutFor(input: ContainerToolInput): number {
  if (input.timeout) return input.timeout
  return LONG_OPS.has(input.op) ? DEFAULT_WALL_TIMEOUT_MS : READ_TIMEOUT_MS
}

/** Container ids that are live in a snapshot. */
function liveIds(containers: readonly ContainerInfo[]): string[] {
  return containers
    .filter(c => c.state === 'running' || c.state === 'restarting')
    .map(c => c.id)
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

async function runPs(
  input: ContainerToolInput,
  opts: RunContainerOpOptions,
  command: string,
  startedAt: number,
): Promise<ContainerToolOutput> {
  const { containers, error } = await snapshotProjectContainers(
    opts.cwd,
    opts.abortSignal,
  )
  if (error !== null) {
    const diagnosis = classifyCommandFailure(error, { context: 'run' })
    return failure(input.op, command, 1, error, diagnosis, startedAt)
  }
  const rows: ContainerRow[] = containers.map(container => ({
    container,
    diagnosis: classifyContainer(container),
  }))
  return {
    op: input.op,
    command,
    exitCode: 0,
    output: formatRows(rows),
    diagnosis: null,
    rows,
    durationMs: Date.now() - startedAt,
  }
}

export function formatRows(rows: readonly ContainerRow[]): string {
  if (rows.length === 0) {
    return 'No containers for this project.'
  }
  const lines: string[] = []
  for (const { container, diagnosis } of rows) {
    const ports = container.ports
      .map(p => p.hostPort)
      .filter((p): p is number => p !== null)
    const portText = ports.length ? `  ${[...new Set(ports)].map(p => `:${p}`).join(' ')}` : ''
    lines.push(`${container.name}  ${container.status}${portText}`)
    if (diagnosis) lines.push(`  ! ${diagnosis.summary}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

function satisfies(container: ContainerInfo, until: WaitUntil): boolean {
  switch (until) {
    case 'healthy':
      return container.health === 'healthy'
    case 'running':
      return container.state === 'running'
    case 'exited':
      return container.state === 'exited'
  }
}

function findTarget(
  containers: readonly ContainerInfo[],
  service: string,
): ContainerInfo | undefined {
  return containers.find(
    c => c.service === service || c.name === service || c.id.startsWith(service),
  )
}

async function runWait(
  input: ContainerToolInput,
  opts: RunContainerOpOptions,
  command: string,
  startedAt: number,
): Promise<ContainerToolOutput> {
  const service = input.service ?? ''
  const until = input.until ?? 'healthy'
  const deadline = startedAt + (input.timeout ?? DEFAULT_WAIT_TIMEOUT_MS)

  let last: ContainerInfo | undefined
  while (Date.now() < deadline) {
    if (opts.abortSignal?.aborted) break
    const { containers, error } = await snapshotProjectContainers(
      opts.cwd,
      opts.abortSignal,
    )
    if (error !== null) {
      const diagnosis = classifyCommandFailure(error, { context: 'run' })
      return failure(input.op, command, 1, error, diagnosis, startedAt)
    }
    const target = findTarget(containers, service)
    if (target) {
      last = target
      if (satisfies(target, until)) {
        return waitResult(input, command, startedAt, target, true)
      }
      // (a) Fail fast when the wait can never succeed. `health: 'none'` is only
      // trustworthy for a RUNNING container — on a created or restarting one it
      // also covers "docker has not reported a verdict yet".
      if (until === 'healthy' && target.state === 'running') {
        const impossible = diagnoseNoHealthcheck(target)
        if (impossible) {
          return waitResult(input, command, startedAt, target, false, impossible)
        }
      }
      // (b) `starting` is the healthcheck's start_period. Not a failure — keep
      // waiting silently.
    }
    await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS))
  }

  // (c) On timeout, report what was actually observed rather than a bare
  // "timed out" — the last status line is what says why it never arrived.
  return waitResult(input, command, startedAt, last, false)
}

function waitResult(
  input: ContainerToolInput,
  command: string,
  startedAt: number,
  target: ContainerInfo | undefined,
  satisfied: boolean,
  impossible?: Diagnosis,
): ContainerToolOutput {
  const until = input.until ?? 'healthy'
  const waitedMs = Date.now() - startedAt
  const observedState = target?.state ?? 'absent'
  const observedHealth = target?.health ?? 'none'
  const detail = target ? ` Last status: ${target.status}` : ''
  const body = satisfied
    ? `${target?.name ?? input.service} reached ${until} after ${Math.round(waitedMs / 1000)}s.`
    : impossible
      ? `${impossible.summary}.${detail}`
      : `${input.service} did not reach ${until} within ${Math.round(waitedMs / 1000)}s — observed ${observedState}/${observedHealth}.${detail}`
  return {
    op: input.op,
    command,
    exitCode: satisfied ? 0 : 1,
    output: body,
    diagnosis: impossible ?? (target ? classifyContainer(target) : null),
    wait: {
      satisfied,
      observedState,
      observedHealth,
      waitedMs,
      ...(impossible ? { impossible: impossible.summary } : {}),
    },
    durationMs: waitedMs,
  }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export function summarizeBuild(summary: BuildKitSummary): string {
  if (summary.allCached) {
    // BuildTool's rule: a cached run compiled nothing, so reporting it as a
    // clean build would describe a compilation that never happened.
    return `Up to date, nothing rebuilt (${summary.cachedCount} cached stages).`
  }
  const parts = [`${summary.rebuiltCount} rebuilt`, `${summary.cachedCount} cached`]
  if (summary.writtenImages.length > 0) {
    parts.push(`wrote ${summary.writtenImages.join(', ')}`)
  }
  return `Built: ${parts.join(', ')}.`
}

export function buildFailureText(summary: BuildKitSummary): string | null {
  const f = summary.failure
  if (!f) return null
  // The step-anchored output, NOT a tail: BuildKit interleaves steps, so the
  // last lines of the log routinely belong to a different step than the one
  // that failed.
  const head = `#${f.stepIndex} ${f.stepLabel} failed${
    f.exitCode !== null ? ` with exit code ${f.exitCode}` : ''
  }${f.command ? `: ${f.command}` : ''}`
  return [head, ...f.output].join('\n')
}

/**
 * The streamed ops: `build` and `up`.
 *
 * They do not go through `runDocker`, which buffers — a buffered exec exposes
 * nothing while the command runs, so the live label could only be computed once
 * at the end and there would be no stream to measure silence against. See
 * `buildProgress.ts`.
 */
async function runStreamingOp(
  input: ContainerToolInput,
  opts: RunContainerOpOptions,
  built: BuiltCommand,
  command: string,
  startedAt: number,
): Promise<ContainerToolOutput> {
  const context = input.op === 'build' ? 'build' : 'run'
  const streamed = await runStreamingDocker({
    argv: built.argv,
    cwd: opts.cwd,
    abortSignal: opts.abortSignal,
    timeoutMs: timeoutFor(input),
    idleTimeoutMs: input.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_MS,
    onProgress: opts.onProgress,
  })

  // The command could not be run at all — a missing shell, a deleted cwd.
  if (streamed.runError !== undefined) {
    return failure(
      input.op,
      command,
      1,
      streamed.runError,
      classifyCommandFailure(streamed.runError, { context }),
      startedAt,
    )
  }

  // An observation about how the run went quiet, carried on both the success
  // and the failure branch. Never a diagnosis: a long `RUN apt-get` is
  // legitimately silent.
  const stall = streamed.stall ? { stall: streamed.stall } : {}

  if (input.op === 'build') {
    const summary = parseBuildKit(streamed.text)
    if (streamed.exitCode !== 0) {
      return {
        ...failure(
          input.op,
          command,
          streamed.exitCode,
          buildFailureText(summary) ?? streamed.text,
          classifyCommandFailure(streamed.text, { context: 'build' }),
          startedAt,
        ),
        build: summary,
        ...stall,
      }
    }
    const out: ContainerToolOutput = {
      op: input.op,
      command,
      exitCode: 0,
      output: summarizeBuild(summary),
      diagnosis: null,
      build: summary,
      ...stall,
      durationMs: Date.now() - startedAt,
    }
    if (summary.contextBytes !== null && summary.contextBytes >= FAT_CONTEXT_BYTES) {
      out.contextWarning = `the build context transferred ${humanBytes(summary.contextBytes)} — a missing or incomplete .dockerignore is the usual cause`
    }
    return out
  }

  if (streamed.exitCode !== 0) {
    return {
      ...failure(
        input.op,
        command,
        streamed.exitCode,
        streamed.text.trim() || `exited ${streamed.exitCode}`,
        classifyCommandFailure(streamed.text, { context }),
        startedAt,
      ),
      ...stall,
    }
  }

  // `up` brought containers up; record which are ours so the footer's stop
  // dialog can word its warning correctly.
  const { containers } = await snapshotProjectContainers(opts.cwd, opts.abortSignal)
  markContainersStartedByUs(liveIds(containers))

  const shaped = shapeOutput(command, streamed.text)
  return {
    op: input.op,
    command,
    exitCode: 0,
    output: shaped.body,
    diagnosis: null,
    ...(shaped.filtered ? { filtered: shaped.filtered } : {}),
    ...stall,
    durationMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// shared result shapes
// ---------------------------------------------------------------------------

function failure(
  op: ContainerOp,
  command: string,
  exitCode: number,
  raw: string,
  diagnosis: Diagnosis | null,
  startedAt: number,
): ContainerToolOutput {
  // Raw text, with the diagnosis prepended. Never shaped, never capped: a
  // failure's noise IS the signal.
  const body = diagnosis ? `${diagnosis.summary}\n\n${raw}` : raw
  return {
    op,
    command,
    exitCode,
    output: body,
    diagnosis,
    durationMs: Date.now() - startedAt,
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function runContainerOp(
  input: ContainerToolInput,
  opts: RunContainerOpOptions,
): Promise<ContainerToolOutput> {
  const startedAt = Date.now()
  const ctx: BuildCommandContext = { composeFile: opts.composeFile }
  const built = buildContainerCommand(input, ctx)
  const command = built.commandString
  const cwd = input.directory ?? opts.cwd

  if (input.op === 'ps') {
    return runPs(input, { ...opts, cwd }, command, startedAt)
  }
  if (input.op === 'wait') {
    return runWait(input, { ...opts, cwd }, command, startedAt)
  }

  // A followed log or a backgrounded build becomes a monitor task, so the user
  // watches it in the footer and the model gets deltas instead of a blocked
  // turn. Headless has no footer, so it degrades to the foreground rather than
  // spawning something nobody can see.
  const wantsBackground =
    (input.op === 'build' && input.background === true) ||
    (input.op === 'logs' && input.follow === true)
  if (wantsBackground && opts.spawn && !getIsNonInteractiveSession()) {
    return spawnBackground(input, opts, built.commandString, startedAt)
  }

  // `build` and `up` need to be watched while they run, so they take the
  // streaming path instead of the buffered one.
  if (STREAMING_OPS.has(input.op)) {
    return runStreamingOp(input, { ...opts, cwd }, built, command, startedAt)
  }

  const result = await runDocker(built.argv, {
    cwd,
    timeout: timeoutFor(input),
    abortSignal: opts.abortSignal,
  })

  if (result.code !== 0) {
    const diagnosis = classifyCommandFailure(result.stderr, {
      stdout: result.stdout,
      context: 'run',
    })
    return failure(
      input.op,
      command,
      result.code,
      `${result.stdout}${result.stderr}`.trim() || `exited ${result.code}`,
      diagnosis,
      startedAt,
    )
  }

  if (input.op === 'logs') {
    const target = input.service
      ? findTarget(
          (await snapshotProjectContainers(cwd, opts.abortSignal)).containers,
          input.service,
        )
      : undefined
    const logs = extractLogErrors(result.stdout, {
      containerState: target?.state,
    })
    return {
      op: input.op,
      command,
      exitCode: 0,
      output: formatLogs(logs, result.stdout),
      diagnosis: null,
      logs,
      durationMs: Date.now() - startedAt,
    }
  }

  // After bringing something up, record which containers we started so the
  // footer's stop dialog can word its warning correctly.
  if (STARTING_OPS.has(input.op)) {
    const { containers } = await snapshotProjectContainers(cwd, opts.abortSignal)
    markContainersStartedByUs(liveIds(containers))
  }

  const raw = result.stdout || result.stderr
  const shaped = shapeOutput(command, raw)
  return {
    op: input.op,
    command,
    exitCode: 0,
    output: shaped.body,
    diagnosis: null,
    ...(shaped.filtered ? { filtered: shaped.filtered } : {}),
    durationMs: Date.now() - startedAt,
  }
}

export function formatLogs(
  logs: ReturnType<typeof extractLogErrors>,
  raw: string,
): string {
  switch (logs.kind) {
    case 'driver-unreadable':
      // Not "no errors" — reporting it that way would be a lie.
      return logs.message
    case 'empty':
      return logs.reason === 'died-before-writing'
        ? 'No logs: the container died before writing anything.'
        : 'No logs written yet.'
    case 'no-errors':
      return raw.trim() || `No errors in ${logs.totalLines} lines.`
    case 'errors': {
      const body = logs.blocks.map(b => b.lines.join('\n')).join('\n\n')
      const dropped =
        logs.droppedBlocks > 0
          ? `\n\n… ${logs.droppedBlocks} more error blocks elided`
          : ''
      return `${body}${dropped}`
    }
  }
}

async function spawnBackground(
  input: ContainerToolInput,
  opts: RunContainerOpOptions,
  command: string,
  startedAt: number,
): Promise<ContainerToolOutput> {
  const spawnCtx = opts.spawn
  if (!spawnCtx) {
    throw new Error('spawnBackground called without spawn plumbing')
  }
  const shellCommand = await exec(
    command,
    spawnCtx.abortController.signal,
    'bash',
    { timeout: input.timeout ?? DEFAULT_WALL_TIMEOUT_MS },
  )
  const handle = await spawnShellTask(
    {
      command,
      description:
        input.op === 'build'
          ? `docker build ${input.service ?? ''}`.trim()
          : `docker logs ${input.service ?? ''}`.trim(),
      shellCommand,
      toolUseId: opts.toolUseId,
      kind: 'monitor',
    } as never,
    {
      abortController: spawnCtx.abortController,
      getAppState: () => {
        throw new Error('getAppState not available in Container spawn context')
      },
      setAppState: spawnCtx.setAppState,
    } as never,
  )
  return {
    op: input.op,
    command,
    exitCode: 0,
    output: `Started in the background as task ${handle.taskId}. Output streams to ${getTaskOutputPath(handle.taskId)}.`,
    diagnosis: null,
    backgroundTaskId: handle.taskId,
    durationMs: Date.now() - startedAt,
  }
}

/** Re-exported so the tool can decide plan-mode eligibility without importing
 * the types module separately. */
export { isReadOnlyOp }
