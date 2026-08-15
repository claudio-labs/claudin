// Integration tests for the bash output filter hook in BashTool.
//
// These tests verify that applyBashOutputFilter() — the Phase 3 integration
// helper exported from BashTool.tsx — correctly honours the
// `bashOutputFilterEnabled` config flag, the
// `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER` kill switch, and the backgroundTaskId
// guard.
//
// The outputFilter internals (pipeline stages, individual filters, markers)
// are covered by src/outputFilter/Bash/bashFilter.test.ts. This suite tests
// only the BashTool integration boundary.
//
// Mocking strategy — follows the project convention (no mock.module()):
//   • Config  → saveGlobalConfig() mutates TEST_GLOBAL_CONFIG_FOR_TESTING
//               (NODE_ENV=test path in getGlobalConfig). Restored in afterEach.
//   • Env var → process.env mutation with save/restore in afterEach.
//   • ExecResult → plain object literals (no shell subprocess needed here).

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getGlobalConfig, resetGlobalConfigForTests, saveGlobalConfig } from 'src/platform/config/config.js'
import type { ExecResult } from 'src/shared/proc/ShellCommand.js'
import {
  applyBashOutputFilter,
  type BashToolInput,
  planBashFilterForExecution,
  shouldFilterOutput,
} from 'src/tools/BashTool/BashTool.js'
import { getBytesSaved, resetBytesSaved } from 'src/agent/context/tokensSaved.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal ExecResult for a successful foreground command. */
function makeResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: 'some output\n',
    stderr: '',
    code: 0,
    interrupted: false,
    ...overrides,
  }
}

/** Sample output that matches the ls-la filter (registered in Phase 6.1.2). */
const LS_LA_SAMPLE = [
  'total 64',
  'drwxr-xr-x  2 root root 4096 Jan  1 00:00 .',
  'drwxr-xr-x 19 root root 4096 Jan  1 00:00 ..',
  '-rw-r--r--  1 root root  220 Jan  1 00:00 .bash_logout',
  '-rw-r--r--  1 root root 3526 Jan  1 00:00 .bashrc',
  '-rw-r--r--  1 root root  807 Jan  1 00:00 .profile',
].join('\n') + '\n'

// ---------------------------------------------------------------------------
// State management helpers
// ---------------------------------------------------------------------------

let savedBashOutputFilterEnabled: boolean | undefined

function enableFilter(): void {
  saveGlobalConfig(c => ({ ...c, bashOutputFilterEnabled: true }))
}

function disableFilter(): void {
  saveGlobalConfig(c => ({ ...c, bashOutputFilterEnabled: false }))
}

beforeEach(() => {
  savedBashOutputFilterEnabled = getGlobalConfig().bashOutputFilterEnabled
})

afterEach(() => {
  saveGlobalConfig(c => ({
    ...c,
    bashOutputFilterEnabled: savedBashOutputFilterEnabled,
  }))
})

afterAll(() => {
  resetGlobalConfigForTests()
})

// ---------------------------------------------------------------------------
// Suite 1 — config guard
// ---------------------------------------------------------------------------

describe('bash output filter — config guard', () => {
  test('flag explicitly false → passthrough, no markers', () => {
    disableFilter()

    const result = makeResult({ stdout: LS_LA_SAMPLE })
    applyBashOutputFilter(result, 'ls -la')

    expect(result.stdout).toBe(LS_LA_SAMPLE)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })

  test('config enabled + ls -la → stdout wrapped with filter markers', () => {
    enableFilter()

    const result = makeResult({ stdout: LS_LA_SAMPLE })
    applyBashOutputFilter(result, 'ls -la')

    expect(result.stdout).toContain('<bash-output-filtered')
    expect(result.stdout).toContain('reduction=')
    // Closing tag present (well-formed XML)
    expect(result.stdout).toContain('</bash-output-filtered>')
  })

  // Kill switch tested via shouldFilterOutput (pure function) in Suite 3.

  test('net reduction is recorded in the tokens-saved counter', () => {
    // git-log filter caps at maxLines: 50, so a 1000-line log nets a real
    // reduction past the marker overhead. Guards the recordBytesSaved wire in
    // applyBashOutputFilter — remove it and this fails.
    enableFilter()
    resetBytesSaved()

    const bigLog =
      Array.from(
        { length: 1000 },
        (_, i) => `commit ${i} some message line here padding padding`,
      ).join('\n') + '\n'
    const result = makeResult({ stdout: bigLog })
    applyBashOutputFilter(result, 'git log')

    expect(result.stdout).toContain('<bash-output-filtered')
    expect(getBytesSaved()).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 2 — guard conditions
// ---------------------------------------------------------------------------

describe('bash output filter — guard conditions', () => {
  test('background task → stdout unchanged even when config is enabled', () => {
    enableFilter()

    const result = makeResult({
      stdout: LS_LA_SAMPLE,
      backgroundTaskId: 'bg-task-123',
    })
    applyBashOutputFilter(result, 'ls -la')

    // backgroundTaskId guard → passthrough
    expect(result.stdout).toBe(LS_LA_SAMPLE)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })

  test('ls -la + empty stdout → returns empty string, no marker (pipeline short-circuits at line 61 of index.ts)', () => {
    // applyBashFilterToStdout: `if (rawStdout === "") return ""` — empty output
    // is always a passthrough regardless of which filter matched the command.
    enableFilter()

    const result = makeResult({ stdout: '' })
    applyBashOutputFilter(result, 'ls -la')

    expect(result.stdout).toBe('')
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })

  test('command with no registered filter + empty stdout → passthrough, no crash', () => {
    // Separate axis from above: no filter matched AND stdout is empty.
    // Guard: !plan.filter && !plan.rewrite → return rawStdout (which is '').
    enableFilter()

    const result = makeResult({ stdout: '' })
    applyBashOutputFilter(result, 'date')

    expect(result.stdout).toBe('')
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })

  test('command with non-zero exit code → no filter marker (isError path in applyBashFilterToStdout)', () => {
    // applyBashFilterToStdout skips the pipeline on errors and does not add
    // a filter marker. With rewrite=null this is a pure passthrough.
    enableFilter()

    const stderr = 'ls: cannot access \'/nonexistent\': No such file or directory\n'
    const result = makeResult({ stdout: stderr, code: 2 })
    applyBashOutputFilter(result, 'ls -la /nonexistent')

    // Error path: pipeline is skipped, no filter marker
    expect(result.stdout).not.toContain('filter="ls-la"')
    // Original error message preserved
    expect(result.stdout).toContain('No such file or directory')
  })

  test('command with no matching filter → passthrough, no marker', () => {
    enableFilter()

    const output = 'Tue Jan  1 00:00:00 UTC 2000\n'
    const result = makeResult({ stdout: output })
    applyBashOutputFilter(result, 'date')

    // date has no registered filter → filter=null + rewrite=null → passthrough
    expect(result.stdout).toBe(output)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })
})

// ---------------------------------------------------------------------------
// Suite 2b — pre-exec rewrite plan (planBashFilterForExecution)
// ---------------------------------------------------------------------------

describe('bash output filter — pre-exec rewrite plan', () => {
  let savedRewriteEnabled: boolean | undefined

  beforeEach(() => {
    savedRewriteEnabled = getGlobalConfig().bashOutputFilterRewriteEnabled
    enableFilter()
  })

  afterEach(() => {
    saveGlobalConfig(c => ({
      ...c,
      bashOutputFilterRewriteEnabled: savedRewriteEnabled,
    }))
  })

  test('foreground git log → plan rewrites to --oneline (the command that will execute)', () => {
    const plan = planBashFilterForExecution({ command: 'git log' } as BashToolInput)
    expect(plan.effectiveCommand).toBe('git log --oneline')
    expect(plan.rewrite).toEqual({ from: 'git log', to: 'git log --oneline' })
  })

  test('run_in_background → no rewrite (output goes to disk, keep the asked-for command)', () => {
    const plan = planBashFilterForExecution({
      command: 'git log',
      run_in_background: true,
    } as BashToolInput)
    expect(plan.effectiveCommand).toBe('git log')
    expect(plan.rewrite).toBeNull()
  })

  test('bashOutputFilterRewriteEnabled: false → filter kept, rewrite suppressed', () => {
    saveGlobalConfig(c => ({ ...c, bashOutputFilterRewriteEnabled: false }))
    const plan = planBashFilterForExecution({ command: 'git log' } as BashToolInput)
    expect(plan.effectiveCommand).toBe('git log')
    expect(plan.rewrite).toBeNull()
    expect(plan.filter?.name).toBe('git-log')
  })

  test('master flag off → no rewrite either (never execute a command the filter will not annotate)', () => {
    disableFilter()
    const plan = planBashFilterForExecution({ command: 'git log' } as BashToolInput)
    expect(plan.effectiveCommand).toBe('git log')
    expect(plan.rewrite).toBeNull()
  })

  test('applyBashOutputFilter without a plan never emits a rewrite marker', () => {
    // Legacy/no-plan callers did not execute a rewritten command — the marker
    // must not claim one. `git log` would plan a rewrite if allowed.
    const result = makeResult({ stdout: 'commit abc123\nAuthor: x\n\n    msg\n' })
    applyBashOutputFilter(result, 'git log')
    expect(result.stdout).not.toContain('<bash-output-rewritten')
    expect(result.stdout).not.toContain('actual=')
  })

  test('backgrounded run with an executed rewrite → disclosure note, no markers', () => {
    // The background guard skips filtering (output goes to disk), but the
    // rewritten command IS what's running — the model must learn that before
    // it reads the task output file.
    const plan = planBashFilterForExecution({ command: 'git log' } as BashToolInput)
    expect(plan.rewrite).not.toBeNull()
    const result = makeResult({ stdout: 'partial output', backgroundTaskId: 'bg-99' })
    applyBashOutputFilter(result, 'git log', plan)
    expect(result.stdout).toContain('partial output')
    expect(result.stdout).toContain('running: git log --oneline')
    expect(result.stdout).not.toContain('<bash-output-')
  })

  test('semantic error verdict (even with exit code 0) skips the pipeline', () => {
    // call() folds interpretCommandResult.isError into the filter's isError —
    // semantically-failed output must reach the model untouched.
    const result = makeResult({ stdout: LS_LA_SAMPLE, code: 0 })
    applyBashOutputFilter(result, 'ls -la', undefined, true)
    expect(result.stdout).toBe(LS_LA_SAMPLE)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })
})

// ---------------------------------------------------------------------------
// Suite 3 — kill switch (shouldFilterOutput pure-function tests)
// ---------------------------------------------------------------------------

describe('bash output filter — kill switch (shouldFilterOutput)', () => {
  // isBashOutputFilterDisabled is captured at module load time — runtime env
  // mutations have no effect. shouldFilterOutput is the extracted pure function
  // that encapsulates the guard logic, making the kill-switch path testable
  // without a subprocess.

  test('kill switch active → returns false regardless of flag', () => {
    expect(shouldFilterOutput(true, true, undefined)).toBe(false)
    expect(shouldFilterOutput(false, true, undefined)).toBe(false)
  })

  test('kill switch inactive + flag enabled + no backgroundTaskId → returns true', () => {
    expect(shouldFilterOutput(true, false, undefined)).toBe(true)
  })

  test('kill switch inactive + flag explicitly disabled → returns false', () => {
    expect(shouldFilterOutput(false, false, undefined)).toBe(false)
  })

  test('kill switch inactive + flag undefined (default) → returns true', () => {
    expect(shouldFilterOutput(undefined, false, undefined)).toBe(true)
  })

  test('kill switch inactive + backgroundTaskId set → returns false', () => {
    // Guard composition: kill switch off but backgroundTaskId blocks filter
    expect(shouldFilterOutput(true, false, 'bg-456')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suite 4 — regression: filter off preserves raw output
// ---------------------------------------------------------------------------

describe('bash output filter — regression (filter off)', () => {
  // Filter is now default-on; explicitly disable for these passthrough tests.
  beforeEach(() => disableFilter())

  test('ls -la with config off → raw output preserved exactly, no markers', () => {
    const result = makeResult({ stdout: LS_LA_SAMPLE })
    applyBashOutputFilter(result, 'ls -la')

    expect(result.stdout).toBe(LS_LA_SAMPLE)
    expect(result.stdout).not.toContain('<bash-output-filtered')
    // Spot-check raw content is intact
    expect(result.stdout).toContain('total 64')
    expect(result.stdout).toContain('drwxr-xr-x')
  })

  test('echo output with config off → output unchanged', () => {
    const sentinel = `sentinel-${Date.now()}`
    const result = makeResult({ stdout: `${sentinel}\n` })
    applyBashOutputFilter(result, `echo ${sentinel}`)

    expect(result.stdout).toContain(sentinel)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })
})

// ---------------------------------------------------------------------------
// Suite 4 — integration smoke (filter enabled, real filter interaction)
// ---------------------------------------------------------------------------

describe('bash output filter — integration smoke', () => {
  test('ps aux output with filter enabled → wrapped with markers, not empty', () => {
    enableFilter()

    // Fabricate a minimal ps aux header to trigger the ps-aux filter
    const psOutput = [
      'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
      'root           1  0.0  0.0 168928 11452 ?        Ss   00:00   0:01 /sbin/init',
      'root           2  0.0  0.0      0     0 ?        S    00:00   0:00 [kthreadd]',
      'user        1234  0.1  0.5 123456  5678 pts/0    S+   00:01   0:00 bash',
    ].join('\n') + '\n'

    const result = makeResult({ stdout: psOutput })
    applyBashOutputFilter(result, 'ps aux')

    expect(result.stdout).toContain('<bash-output-filtered')
    expect(result.stdout).toContain('</bash-output-filtered>')
    // Should not be empty inside the marker
    const lines = result.stdout.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(1)
  })

  test('applyBashOutputFilter returns the same result object (mutates in place)', () => {
    enableFilter()

    const result = makeResult({ stdout: LS_LA_SAMPLE })
    const returned = applyBashOutputFilter(result, 'ls -la')

    // Must return the same reference (not a copy)
    expect(returned).toBe(result)
  })

  test('python3 --version (no registered filter) with filter enabled → passthrough, no crash', () => {
    enableFilter()

    const output = 'Python 3.11.0\n'
    const result = makeResult({ stdout: output })
    applyBashOutputFilter(result, 'python3 --version')

    // No filter registered for python3 → pure passthrough
    expect(result.stdout).toBe(output)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })
})

// ---------------------------------------------------------------------------
// Suite 5 — filter + summarizer interaction (double-processing guard)
// ---------------------------------------------------------------------------
//
// Verifies that bash output already wrapped in <bash-output-filtered> markers
// is NOT re-processed by the bash filter pipeline. The filter pipeline must
// short-circuit on already-filtered input to prevent double-wrapping and to
// guarantee that the summarizer sees the filtered (reduced) content — not the
// original — when both features are enabled simultaneously.

describe('bash output filter — filter+summarizer interaction', () => {
  test('already-filtered output is not re-wrapped when passed through the pipeline again', () => {
    enableFilter()

    // Simulate output that already went through the filter (e.g. from a
    // sub-agent that also runs with filter enabled).
    const preFiltered = [
      '<bash-output-filtered filter="ls-la" lines_in="6" lines_out="2" reduction="67%">',
      'drwxr-xr-x  2 root root 4096 Jan  1 00:00 .',
      '-rw-r--r--  1 root root  220 Jan  1 00:00 .bash_logout',
      '</bash-output-filtered>',
    ].join('\n') + '\n'

    const result = makeResult({ stdout: preFiltered })
    applyBashOutputFilter(result, 'ls -la')

    // Must NOT contain a nested <bash-output-filtered inside the outer one
    const markerCount = (result.stdout.match(/<bash-output-filtered/g) ?? []).length
    expect(markerCount).toBe(1)
  })

  test('filter reduces output before it could reach the summarizer threshold', () => {
    enableFilter()

    // Build ls-like output large enough that the raw form could be summarized,
    // but small enough after filtering that summarization is skipped.
    const lines = Array.from(
      { length: 300 },
      (_, i) => `-rw-r--r--  1 user group ${1000 + i} Jan  1 00:00 file-${i.toString().padStart(4, '0')}.ts`,
    )
    const bigLsOutput = ['total 300', ...lines].join('\n') + '\n'

    const result = makeResult({ stdout: bigLsOutput })
    applyBashOutputFilter(result, 'ls -la')

    // Filter should have applied (markers present)
    expect(result.stdout).toContain('<bash-output-filtered')
    expect(result.stdout).toContain('</bash-output-filtered>')

    // Filtered output must be strictly smaller than the original
    expect(result.stdout.length).toBeLessThan(bigLsOutput.length)
  })

  test('filter off → full output reaches downstream unchanged', () => {
    disableFilter()

    const lines = Array.from(
      { length: 50 },
      (_, i) => `-rw-r--r--  1 user group ${100 + i} Jan  1 00:00 file-${i}.ts`,
    )
    const raw = ['total 50', ...lines].join('\n') + '\n'

    const result = makeResult({ stdout: raw })
    applyBashOutputFilter(result, 'ls -la')

    // No filtering applied — downstream sees the original content
    expect(result.stdout).toBe(raw)
    expect(result.stdout).not.toContain('<bash-output-filtered')
  })
})

// ---------------------------------------------------------------------------
// Suite 6 — catch path (fail-open / belt-and-suspenders)
// ---------------------------------------------------------------------------

describe('bash output filter — catch path (fail-open)', () => {
  // applyBashOutputFilter wraps planBashFilter + applyBashFilterToStdout in a
  // try/catch. Both functions internally use safeApply, so the catch in
  // applyBashOutputFilter is currently unreachable without mocking internals.
  //
  // This suite tests the observable guarantee: `result.stdout` is always
  // returned unchanged when the filter pipeline is a no-op — verifying that
  // the fail-open contract holds end-to-end across all code paths.
  //
  // If the catch ever becomes reachable (e.g. safeApply removed from
  // planBashFilter), the integration tests in Suite 1 would catch the
  // regression. A direct unit test requires mock.module which this file
  // deliberately avoids to keep test isolation simple.

  test('result.stderr is never mutated regardless of filter path', () => {
    enableFilter()

    const originalStderr = 'some error on stderr\n'
    const result = makeResult({ stdout: LS_LA_SAMPLE, stderr: originalStderr })
    applyBashOutputFilter(result, 'ls -la')

    // filter only touches stdout — stderr must be preserved exactly
    expect(result.stderr).toBe(originalStderr)
  })

  test('result object identity preserved — always returns same reference', () => {
    // Verifies fail-open contract: every code path (guard passthrough, filter
    // applied, catch) returns the original result object, never a copy.
    enableFilter()

    const result = makeResult({ stdout: LS_LA_SAMPLE })
    const returned = applyBashOutputFilter(result, 'ls -la')
    expect(returned).toBe(result)

    // Also verify for the guard passthrough path (backgroundTaskId set)
    const result2 = makeResult({ stdout: LS_LA_SAMPLE, backgroundTaskId: 'bg-1' })
    const returned2 = applyBashOutputFilter(result2, 'ls -la')
    expect(returned2).toBe(result2)

    // And for the config-off path (no filter applied)
    disableFilter()
    const result3 = makeResult({ stdout: LS_LA_SAMPLE })
    const returned3 = applyBashOutputFilter(result3, 'ls -la')
    expect(returned3).toBe(result3)
  })
})
