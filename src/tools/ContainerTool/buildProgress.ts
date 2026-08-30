// Streaming execution for the docker ops that legitimately take minutes.
//
// `runDocker` wraps `execFileNoThrowWithCwd`, which BUFFERS: it hands back the
// whole output at the end and exposes nothing while the command runs. That is
// right for `docker ps` and wrong for `docker build`, where it costs both of
// the things the build op exists for — a live label during a ten-minute
// Dockerfile, and any way at all to notice that the build has gone quiet.
//
// So `build` and `up` come through here instead, riding the same mechanism the
// Build tool uses. Everything else stays on `runDocker`.

import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { readFullShellOutput } from 'src/platform/shell/fullOutput.js'
import { exec, type ExecOptions } from 'src/shared/proc/Shell.js'
import type { ExecResult, ShellCommand } from 'src/shared/proc/ShellCommand.js'
import { logError } from 'src/shared/log.js'
import { dockerBin } from 'src/containers/docker/dockerCli.js'
import { buildProgressLabel } from 'src/containers/build/parseBuildKit.js'
import { lastNonEmptyLine } from 'src/tools/shared/progressTail.js'
import type { ContainerStall } from 'src/tools/ContainerTool/types.js'

/** SIGTERM comes back as this exit code; `interrupted` is only set for SIGKILL. */
const SIGTERM_EXIT = 143

/**
 * How long the output must be frozen before the live label says so. Below this
 * every build would flicker into "silent" between two ordinary lines.
 */
const SILENT_LABEL_MS = 10_000

/**
 * Collapse the carriage-return rewrites a progress renderer leaves behind.
 *
 * `docker compose up` redraws its status block with `\r`, which read as text is
 * one line megabytes long. Keeping only the final segment of each line is what
 * a terminal would have shown. Twin of `stripProgressRewrites` in
 * `BuildTool/run.ts`; kept local rather than importing that module, which would
 * pull the whole diagnostic parser chain in for six lines of string work.
 */
export function stripCarriageRewrites(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n')
}

/** POSIX single-quoting, so a path or argument with spaces survives the shell. */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The argv, as a shell command line.
 *
 * NOT `BuiltCommand.commandString` — that one exists for the permission check
 * and its quoting is not execution-grade. This is the only string in the tool
 * that a shell ever sees, so every element is quoted here rather than trusted.
 */
export function argvToShellCommand(argv: readonly string[]): string {
  return [dockerBin(), ...argv].map(singleQuote).join(' ')
}

export type StreamTick = {
  /** Tail of the output file. */
  lastLines: string
  /** Bytes written so far. Silence is measured on THIS, not on the text: an
   * unchanged tail with a growing file is still progress. */
  totalBytes: number
}

export type ProgressWatcherOptions = {
  /** A stretch with no output at all, after which the run is stopped. */
  idleTimeoutMs: number
  /** Fired when the watchdog trips. The caller aborts. */
  onIdle: (silentMs: number) => void
  /** TUI only. Dropped before serialization, so it costs the model nothing. */
  onLabel?: (label: string) => void
  /** Injectable clock, so the watchdog is testable without waiting minutes. */
  now?: () => number
}

export type ProgressWatcher = {
  tick: (t: StreamTick) => void
  /** How long the output has been frozen, right now. */
  currentSilentMs: () => number
  /** The gap that tripped the watchdog, or null if it never did. */
  idleSilentMs: () => number | null
}

/**
 * The idle watchdog and the live label, as one pure state machine.
 *
 * Both ride the same tick — that is not an implementation detail, it is the
 * only tick there is (`ExecOptions.onProgress`, driven by TaskOutput's shared
 * poller). Extracted from the exec wrapper so the timing rules can be driven by
 * synthetic ticks and a fake clock, with no shell and no docker.
 *
 * Silence is measured and reported. It is never diagnosed: a long
 * `RUN apt-get install` is legitimately quiet, and calling that a hang would be
 * a wrong answer stated confidently.
 */
export function createProgressWatcher({
  idleTimeoutMs,
  onIdle,
  onLabel,
  now = Date.now,
}: ProgressWatcherOptions): ProgressWatcher {
  const startedAt = now()
  let lastBytes = -1
  let lastChangeAt = startedAt
  let firedSilentMs: number | null = null

  return {
    tick({ lastLines, totalBytes }) {
      const at = now()
      if (totalBytes !== lastBytes) {
        lastBytes = totalBytes
        lastChangeAt = at
      }
      const silentMs = at - lastChangeAt
      if (firedSilentMs === null && silentMs >= idleTimeoutMs) {
        firedSilentMs = silentMs
        onIdle(silentMs)
        return
      }
      if (!onLabel) return
      const label =
        silentMs >= SILENT_LABEL_MS
          ? `silent for ${Math.round(silentMs / 1000)}s`
          : buildProgressLabel(stripCarriageRewrites(lastLines))
      if (label) onLabel(label)
    },
    currentSilentMs() {
      return now() - lastChangeAt
    },
    idleSilentMs() {
      return firedSilentMs
    },
  }
}

export type StreamedRun = {
  /** The FULL merged log. BuildKit writes its `#N` records to stderr, and in
   * file mode `exec` interleaves both fds into one file, so this is the whole
   * thing rather than stdout alone. */
  text: string
  exitCode: number
  interrupted: boolean
  /** An observation about how the run went quiet, never a diagnosis. */
  stall?: ContainerStall
  /** Set when the command could not be run at all. */
  runError?: string
}

/** Seam for the tests: the real `exec`, or a fake that lets one drive ticks. */
export type ExecImpl = (
  command: string,
  abortSignal: AbortSignal,
  shellType: 'bash',
  options?: ExecOptions,
) => Promise<ShellCommand>

export type StreamingRunOptions = {
  argv: readonly string[]
  cwd: string
  abortSignal?: AbortSignal
  /** Wall ceiling: the run is stopped at this point however busy it is. */
  timeoutMs: number
  /** Idle threshold: stopped after this long with NO output at all. */
  idleTimeoutMs: number
  onProgress?: (label: string) => void
  execImpl?: ExecImpl
  readOutput?: (result: ExecResult) => Promise<string>
  now?: () => number
}

/**
 * Run a long docker command with a live label and a real idle watchdog.
 *
 * Two calls are load-bearing and neither is automatic: `onProgress` must be
 * passed to `exec` (that is what registers the task) AND `TaskOutput
 * .startPolling` must be called. Missing either one gives no ticks at all, and
 * nothing fails — the label simply never moves, which is the bug this module
 * exists to fix. See `BuildTool/run.ts:186-193`, which documents the same pair.
 *
 * The `cd` wrapper is not decoration: `exec` has NO cwd option, it runs in the
 * session's persistent shell. A sub-agent under a worktree cwd override would
 * otherwise build the MAIN checkout.
 */
export async function runStreamingDocker({
  argv,
  cwd,
  abortSignal,
  timeoutMs,
  idleTimeoutMs,
  onProgress,
  execImpl = exec,
  readOutput = readFullShellOutput,
  now = Date.now,
}: StreamingRunOptions): Promise<StreamedRun> {
  // Braces keep a compound command intact, and CI/NO_COLOR keep an interactive
  // renderer and ANSI escapes out of the text the parser reads.
  const command = `cd ${singleQuote(cwd)} && {
export CI=true NO_COLOR=1
unset FORCE_COLOR
${argvToShellCommand(argv)}
}`

  const internal = new AbortController()
  const forwardAbort = () => internal.abort()
  if (abortSignal?.aborted) internal.abort()
  else abortSignal?.addEventListener('abort', forwardAbort, { once: true })

  const startedAt = now()
  let taskId: string | null = null

  const watcher = createProgressWatcher({
    idleTimeoutMs,
    now,
    onLabel: onProgress,
    onIdle: () => internal.abort(),
  })

  try {
    const shellCommand = await execImpl(command, internal.signal, 'bash', {
      timeout: timeoutMs,
      // The `cd` above is ours, not the user's — it must not move the session's
      // shell out from under the next Bash call.
      preventCwdChanges: true,
      onProgress: (lastLines, _all, _lines, totalBytes) => {
        watcher.tick({ lastLines, totalBytes })
      },
    })

    taskId = shellCommand.taskOutput?.taskId ?? null
    if (taskId) TaskOutput.startPolling(taskId)

    const result = await shellCommand.result
    const text = stripCarriageRewrites(await readOutput(result))
    const ranMs = now() - startedAt
    const lastLine = lastNonEmptyLine(text) ?? ''

    const idleSilentMs = watcher.idleSilentMs()
    if (idleSilentMs !== null) {
      return {
        text,
        exitCode: result.code,
        interrupted: result.interrupted,
        stall: { reason: 'idle', ranMs, silentMs: idleSilentMs, lastLine },
      }
    }

    if (result.code === SIGTERM_EXIT) {
      // The wall ceiling. `silentMs` is measured, not assumed zero: a run can
      // hit the ceiling while quiet without ever crossing the idle threshold.
      return {
        text,
        exitCode: result.code,
        interrupted: result.interrupted,
        stall: {
          reason: 'ceiling',
          ranMs,
          silentMs: watcher.currentSilentMs(),
          lastLine,
        },
      }
    }

    return { text, exitCode: result.code, interrupted: result.interrupted }
  } catch (e) {
    logError(new Error('container: streaming exec failed', { cause: e }))
    return {
      text: '',
      exitCode: 1,
      interrupted: false,
      runError: e instanceof Error ? e.message : String(e),
    }
  } finally {
    if (taskId) TaskOutput.stopPolling(taskId)
    abortSignal?.removeEventListener('abort', forwardAbort)
  }
}
