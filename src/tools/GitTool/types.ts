/** One command's outcome inside a batch. */
export type GitCommandOutcome = {
  /** The command as the model wrote it. */
  command: string
  /** What actually ran — differs when the output filter rewrote it. */
  effectiveCommand: string
  exitCode: number
  /** Filtered stdout+stderr (the shell interleaves them onto one fd). */
  output: string
  interrupted: boolean
  /**
   * Set when the command stopped without finishing AND without failing. Only
   * a watch can produce one. It is what keeps `exit 143` (the ceiling) and
   * `exit 8` (`gh pr checks`: still pending) out of the failure lane, where
   * they would be diagnosed as a broken git command and would stop the batch.
   */
  stall?: GitStall
}

export type GitStallReason =
  /** The wall ceiling was reached — SIGTERM, nothing wrong. */
  | 'ceiling'
  /** The command stopped writing for long enough to look wedged. */
  | 'idle'
  /** `gh pr checks` finished a pass with checks still pending (exit 8). */
  | 'pending'

export type GitStall = {
  reason: GitStallReason
  /** Wall time this command ran for. */
  ranMs: number
  /** How long its output had been frozen; 0 for reasons other than `idle`. */
  silentMs: number
}

/**
 * TUI-only progress, emitted about once a second while a command runs.
 *
 * Every `progress` message is dropped before the request is serialized
 * (`utils/messages/normalize.ts:965`), so nothing here reaches the model.
 */
export type GitProgress = {
  type: 'git_progress'
  /** The command as the model wrote it. */
  command: string
  /** 1-based position in the batch, and its size. */
  index: number
  total: number
  elapsedMs: number
  silentMs: number
}

export type GitBatchResult = {
  outcomes: GitCommandOutcome[]
  /**
   * Commands after the first failure. They were never executed — the batch is
   * `&&`-shaped — and the model has to be told which, or it cannot tell a
   * skipped command from one that silently produced nothing.
   */
  notRun: string[]
  /** Set when the shell itself failed, as opposed to the command exiting non-zero. */
  runError?: string
}
