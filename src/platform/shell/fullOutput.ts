import { readFileRange } from 'src/shared/fs/fsOperations.js'
import { logError } from 'src/shared/log.js'
import type { ExecResult } from 'src/shared/proc/ShellCommand.js'

/**
 * `exec` does NOT hand back everything a command printed.
 *
 * In file mode both fds are written to one output file, and the string on
 * `result.stdout` is only the first `BASH_MAX_OUTPUT_LENGTH` characters read
 * back from it (30 000 by default — see TaskOutput.#readStdoutFromFile and
 * utils/shell/outputLimits.ts). When more was produced, the full text stays on
 * disk and the path arrives as `result.outputFilePath`.
 *
 * That cap is right for a tool result the model reads verbatim, and wrong for
 * anything that PARSES the output: a checker or test runner that printed more
 * than the cap would be summarised from its first few hundred lines, silently,
 * with counts that look plausible. This helper is the one place that knows to
 * prefer the file.
 *
 * Falls back to `result.stdout` on any read failure — a degraded summary beats
 * no result at all.
 */

/** Well past any real compiler/test output; the guard is against a runaway log. */
const MAX_FULL_OUTPUT_BYTES = 32 * 1024 * 1024

export async function readFullShellOutput(result: ExecResult): Promise<string> {
  if (!result.outputFilePath) return result.stdout
  try {
    const range = await readFileRange(result.outputFilePath, 0, MAX_FULL_OUTPUT_BYTES)
    return range?.content ?? result.stdout
  } catch (e) {
    logError(`Failed to read full shell output from ${result.outputFilePath} — ${String(e)}`)
    return result.stdout
  }
}
