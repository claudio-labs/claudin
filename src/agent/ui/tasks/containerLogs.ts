// `docker logs --tail 50` for the TUI, kept apart from the dialog so the
// merging and the failure classification are testable without React.
//
// This is deliberately NOT `src/containers/diagnostics/extractLogErrors.ts`.
// That one answers "what went wrong" for the model and throws away everything
// it does not consider an error — the right shape for a tool result, the wrong
// shape for a human who asked to see the logs. Here the user gets the tail
// verbatim.

import { runDocker, describeUnavailable } from 'src/containers/docker/dockerCli.js'

/** How many lines `docker logs` is asked for, and the most that are shown. */
export const CONTAINER_LOG_TAIL = 50

const TIMEOUT_MS = 10_000

/** `2026-09-06T12:34:56.789012345Z ` — docker's `--timestamps` prefix. */
const TS_RE = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z) (.*)$/

export type ContainerLogLine = {
  /** `12:34:56`, or null for a line docker did not timestamp. */
  time: string | null
  text: string
}

export type ContainerLogs =
  | { kind: 'ok'; lines: ContainerLogLine[] }
  /** The command worked and the container has written nothing. */
  | { kind: 'empty' }
  /** One line, already human-readable. */
  | { kind: 'error'; message: string }

/**
 * True when the line already carries its own clock, so docker's should not be
 * printed in front of it.
 *
 * `--timestamps` is requested for the merge below, not for display, and most
 * server images timestamp their own output — postgres renders as
 * `04:00:45 2026-09-06 04:00:45.415 UTC [27] LOG: …` otherwise, spending ~28
 * columns to say the same thing twice.
 */
export function hasOwnTimestamp(text: string): boolean {
  return LEADING_TIME_RE.test(text)
}

const LEADING_TIME_RE = /^[[(]?(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}/

export function containerLogsArgs(containerId: string): string[] {
  // --timestamps is what makes the two streams mergeable below; it is not
  // cosmetic.
  return ['logs', '--tail', String(CONTAINER_LOG_TAIL), '--timestamps', containerId]
}

/**
 * Merge docker's two streams back into one chronological tail.
 *
 * `docker logs` writes the container's stdout to our stdout and its stderr to
 * our stderr, so taking either alone drops half the output — and most runtimes
 * log to stderr. Concatenating them unsorted is worse than useless, hence the
 * timestamp sort. A line docker did not timestamp (a bare continuation, e.g.
 * the frames of a stack trace some drivers emit unprefixed) inherits the key of
 * the line above it, so a traceback stays in one piece instead of being
 * scattered to the top.
 */
export function mergeLogStreams(stdout: string, stderr: string): ContainerLogLine[] {
  const keyed: { key: string; seq: number; line: ContainerLogLine }[] = []
  let seq = 0
  for (const raw of [stdout, stderr]) {
    let lastKey = ''
    for (const line of raw.split('\n')) {
      if (line === '') continue
      const m = TS_RE.exec(line)
      if (m) {
        lastKey = m[1]!
        keyed.push({ key: lastKey, seq: seq++, line: { time: m[2]!, text: m[3]! } })
      } else {
        keyed.push({ key: lastKey, seq: seq++, line: { time: null, text: line } })
      }
    }
  }
  keyed.sort((a, b) => (a.key === b.key ? a.seq - b.seq : a.key < b.key ? -1 : 1))
  return keyed.slice(-CONTAINER_LOG_TAIL).map(k => k.line)
}

export async function fetchContainerLogs(
  containerId: string,
  abortSignal?: AbortSignal,
): Promise<ContainerLogs> {
  const result = await runDocker(containerLogsArgs(containerId), {
    timeout: TIMEOUT_MS,
    abortSignal,
  })
  if (result.code !== 0) {
    // `unavailable` covers the three ways the CLI itself is unusable; anything
    // else is docker answering, and its own first line is the better message
    // (`Error response from daemon: configured logging driver does not support
    // reading`, a container removed between the snapshot and the keypress, …).
    const message = result.unavailable
      ? describeUnavailable(result.unavailable)
      : (result.stderr.split('\n').find(l => l.trim() !== '') ??
        `docker logs exited with code ${result.code}`)
    return { kind: 'error', message }
  }
  const lines = mergeLogStreams(result.stdout, result.stderr)
  return lines.length === 0 ? { kind: 'empty' } : { kind: 'ok', lines }
}
