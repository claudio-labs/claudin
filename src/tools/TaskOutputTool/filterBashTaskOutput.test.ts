import { describe, expect, test } from 'bun:test'

import { filterBashTaskOutput } from 'src/tools/TaskOutputTool/filterBashTaskOutput.js'

const ANSI_GREEN = '\x1b[32m'
const ANSI_RESET = '\x1b[0m'

/**
 * A long identical run and a colour code — what the generic floor exists for.
 * Deliberately long: the filter-only marker is dropped when the tag costs more
 * bytes than the trim saved, so a six-line fixture would come back correct and
 * unmarked, and the assertion would be about the fixture rather than the lane.
 */
const NOISY = [
  `${ANSI_GREEN}Downloading package${ANSI_RESET}`,
  ...Array.from({ length: 40 }, () => 'waiting for lock'),
  'done',
].join('\n')

describe('filterBashTaskOutput', () => {
  test('removes noise from a backgrounded run and discloses it to the model', () => {
    const filtered = filterBashTaskOutput(NOISY, 'some-unregistered-cmd', 0)
    expect(filtered).toStartWith('<bash-output-filtered')
    expect(filtered).not.toContain(ANSI_GREEN)
    expect(filtered.length).toBeLessThan(NOISY.length)
    // collapseRuns keeps the first of the run verbatim — the cause is never hidden.
    expect(filtered).toContain('waiting for lock')
    expect(filtered).toContain('done')
  })

  // The whole point of `callerBudgets: true`. A monitor task is read by polling
  // and its output only grows, so a head/tail cap would remove a DIFFERENT
  // middle on every read — including lines the model has never seen. This body
  // is far past FLOOR_CAP_LINES and must come back whole.
  test('never caps: a long body with nothing repeated is returned untouched', () => {
    const long = Array.from({ length: 240 }, (_, i) => `line ${i} of the log`).join('\n')
    expect(filterBashTaskOutput(long, 'some-unregistered-cmd', null)).toBe(long)
  })

  test('a task still running has no exit code, and that is not a failure', () => {
    // exitCode null → the success lane, so the noise is wrapped and disclosed.
    expect(filterBashTaskOutput(NOISY, 'some-unregistered-cmd', null)).toStartWith(
      '<bash-output-filtered',
    )
  })

  // A non-zero exit takes ERROR_FLOOR, which never marker-wraps: the string is
  // printed verbatim by the error renderers, and the wrapper would land on the
  // user's screen as escaped XML.
  test('a failed task is still cleaned up, but never marker-wrapped', () => {
    const filtered = filterBashTaskOutput(NOISY, 'some-unregistered-cmd', 1)
    expect(filtered).not.toStartWith('<bash-output-')
    expect(filtered.length).toBeLessThan(NOISY.length)
    // ERROR_FLOOR drops stripAnsi on purpose — the red on a failure is doing its job.
    expect(filtered).toContain(ANSI_GREEN)
  })

  test('passes through when there is no command to resolve a spec against', () => {
    expect(filterBashTaskOutput(NOISY, undefined, 0)).toBe(NOISY)
    expect(filterBashTaskOutput('', 'some-unregistered-cmd', 0)).toBe('')
  })

  test('a matched spec still applies — the chain lands here too', () => {
    // `cd X && CMD | tail -N` resolves to CMD's spec since the reducer split
    // crosses the top-level `&&`; a backgrounded run of that shape reaches the
    // model through this function alone.
    const lsOutput = [
      'total 8',
      'drwxr-xr-x 2 user group 4096 Aug 24 10:00 .',
      'drwxr-xr-x 9 user group 4096 Aug 24 10:00 ..',
      '-rw-r--r-- 1 user group    0 Aug 24 10:00 a.txt',
    ].join('\n')
    const filtered = filterBashTaskOutput(lsOutput, 'cd /tmp && ls -la | tail -40', 0)
    expect(filtered).toStartWith('<bash-output-filtered')
    expect(filtered).toContain('a.txt')
  })
})
