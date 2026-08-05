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
