import { describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  checkDangerousRemovalPaths,
  checkPathConstraints,
  PATH_EXTRACTORS,
  stripWrappersFromArgv,
} from 'src/tools/BashTool/pathValidation.js'

// `checkDangerousRemovalPaths` resolves relative paths against this cwd, so the
// tests pick one whose parent chain reaches `/` — no filesystem access happens.
const CWD = '/tmp'

/** Narrows to the ask branch and hands back the message it carries. */
function askMessage(result: PermissionResult): string {
  if (result.behavior !== 'ask') {
    throw new Error(`expected an ask decision, got '${result.behavior}'`)
  }
  return result.message
}

describe('stripWrappersFromArgv', () => {
  test('strips timeout, nice, stdbuf, env, time and nohup', () => {
    expect(stripWrappersFromArgv(['timeout', '5', 'rm', 'x'])).toEqual([
      'rm',
      'x',
    ])
    expect(stripWrappersFromArgv(['timeout', '-k', '9', '5', 'ls'])).toEqual([
      'ls',
    ])
    expect(stripWrappersFromArgv(['nice', '-n', '10', 'rm', 'x'])).toEqual([
      'rm',
      'x',
    ])
    expect(stripWrappersFromArgv(['stdbuf', '-o0', '-eL', 'rm', 'x'])).toEqual([
      'rm',
      'x',
    ])
    expect(stripWrappersFromArgv(['env', 'FOO=bar', 'rm', 'x'])).toEqual([
      'rm',
      'x',
    ])
    expect(stripWrappersFromArgv(['time', 'rm', 'x'])).toEqual(['rm', 'x'])
    expect(stripWrappersFromArgv(['nohup', 'rm', 'x'])).toEqual(['rm', 'x'])
  })

  test('strips nested wrappers until the real command is exposed', () => {
    expect(
      stripWrappersFromArgv(['timeout', '5', 'nice', '-n', '10', 'rm', 'x']),
    ).toEqual(['rm', 'x'])
  })

  // The regression this guards: `nice rm /outside` used to leave baseCmd='nice',
  // which is not a supported path command, so `/outside` was never validated.
  test('strips the legacy `nice cmd` and `nice -N cmd` forms', () => {
    expect(stripWrappersFromArgv(['nice', 'rm', '/outside'])).toEqual([
      'rm',
      '/outside',
    ])
    expect(stripWrappersFromArgv(['nice', '-5', 'rm', '/outside'])).toEqual([
      'rm',
      '/outside',
    ])
  })

  // `$(id)` is not a safe flag value, so the wrapper must not be stripped —
  // stripping it would hand `ls` to the path checker while bash still runs the
  // substitution.
  test('leaves argv untouched when a timeout flag value is not a safe token', () => {
    // Fused form.
    expect(stripWrappersFromArgv(['timeout', '-k$(id)', '10', 'ls'])).toEqual([
      'timeout',
      '-k$(id)',
      '10',
      'ls',
    ])
    // Space-separated form, which is checked by a different pattern.
    expect(
      stripWrappersFromArgv(['timeout', '-k', '$(id)', '10', 'ls']),
    ).toEqual(['timeout', '-k', '$(id)', '10', 'ls'])
    expect(
      stripWrappersFromArgv(['timeout', '--signal', 'a;id', '10', 'ls']),
    ).toEqual(['timeout', '--signal', 'a;id', '10', 'ls'])
  })

  test('leaves argv untouched when the timeout duration is not recognized', () => {
    // `.5` and `inf` are durations GNU timeout accepts and we do not.
    expect(stripWrappersFromArgv(['timeout', '.5', 'ls'])).toEqual([
      'timeout',
      '.5',
      'ls',
    ])
    expect(stripWrappersFromArgv(['timeout', 'inf', 'ls'])).toEqual([
      'timeout',
      'inf',
      'ls',
    ])
  })

  test('fails closed on env flags that re-split argv or move the cwd', () => {
    for (const flag of ['-S', '-C', '-P']) {
      expect(stripWrappersFromArgv(['env', flag, 'rm', 'x'])).toEqual([
        'env',
        flag,
        'rm',
        'x',
      ])
    }
  })

  test('leaves a non-wrapper command alone', () => {
    expect(stripWrappersFromArgv(['ls', '-la'])).toEqual(['ls', '-la'])
  })
})

describe('PATH_EXTRACTORS', () => {
  // Without `--` handling a path starting with `-` is dropped by the naive
  // flag filter, path validation sees zero paths and returns passthrough.
  test('the flag filter keeps everything after `--`, even if it starts with -', () => {
    expect(PATH_EXTRACTORS.rm(['--', '-/../etc'])).toEqual(['-/../etc'])
  })

  test('find keeps everything after `--`, where it means a search root', () => {
    expect(PATH_EXTRACTORS.find(['--', '-/../../etc'])).toEqual(['-/../../etc'])
  })

  test('still drops flags before `--`', () => {
    expect(PATH_EXTRACTORS.rm(['-rf', 'build'])).toEqual(['build'])
  })
})

describe('checkDangerousRemovalPaths', () => {
  test('asks for a removal of root or a direct child of root', () => {
    expect(checkDangerousRemovalPaths('rm', ['-rf', '/'], CWD).behavior).toBe(
      'ask',
    )
    expect(checkDangerousRemovalPaths('rm', ['/etc'], CWD).behavior).toBe('ask')
    expect(checkDangerousRemovalPaths('rmdir', ['/usr'], CWD).behavior).toBe(
      'ask',
    )
  })

  test('asks for a `--`-hidden path that traverses up to a critical dir', () => {
    // resolve('/tmp', '-/../../etc') === '/etc'
    const result = checkDangerousRemovalPaths('rm', ['--', '-/../../etc'], CWD)
    expect(askMessage(result)).toContain('/etc')
  })

  test('offers no suggestions, so a dangerous removal cannot be saved as a rule', () => {
    const result = checkDangerousRemovalPaths('rm', ['-rf', '/'], CWD)
    if (result.behavior !== 'ask') throw new Error('expected an ask decision')
    expect(result.suggestions).toEqual([])
  })

  test('passes through an ordinary removal inside the project', () => {
    expect(
      checkDangerousRemovalPaths('rm', ['-rf', 'build'], CWD).behavior,
    ).toBe('passthrough')
  })
})

describe('checkPathConstraints', () => {
  const context = getEmptyToolPermissionContext()
  const allowingCwd = (mode: 'default' | 'acceptEdits' = 'default') => ({
    ...getEmptyToolPermissionContext(),
    mode,
    additionalWorkingDirectories: new Map([
      [CWD, { path: CWD, source: 'session' as const }],
    ]),
  })

  test('asks for process substitution, which can write files no redirect names', () => {
    const result = checkPathConstraints(
      { command: 'echo secret > >(tee .git/config)' },
      CWD,
      context,
    )
    expect(askMessage(result)).toContain('Process substitution')

    expect(
      checkPathConstraints({ command: 'cat <(id)' }, CWD, context).behavior,
    ).toBe('ask')
  })

  test('asks when a redirect target carries shell expansion it cannot resolve', () => {
    const result = checkPathConstraints(
      { command: 'echo x > $HOME/pwned' },
      CWD,
      context,
    )
    expect(askMessage(result)).toContain('Shell expansion')
  })

  // The escalation is the point: a dangerous removal must ask even where the
  // ordinary path check would have allowed it (inside a working directory,
  // under acceptEdits). Using a path OUTSIDE the working directories would
  // prove nothing — the working-directory check would ask on its own.
  test('asks for a dangerous removal the ordinary path check would have allowed', () => {
    const result = checkPathConstraints(
      { command: 'rm -rf /tmp' },
      CWD,
      allowingCwd('acceptEdits'),
    )
    expect(askMessage(result)).toContain('Dangerous rm operation')
  })

  test('asks for a write outside every allowed working directory', () => {
    // `context` has no additional working directories, so /etc is off-limits.
    const result = checkPathConstraints(
      { command: 'mkdir /etc/pwned' },
      CWD,
      context,
    )
    expect(askMessage(result)).toContain('was blocked')
  })

  // The shell expands these, we do not — validating the literal text while bash
  // reads something else is the TOCTOU gap both checks close.
  test('asks for a path carrying shell expansion or a tilde variant', () => {
    const expansion = checkPathConstraints(
      { command: 'cat $HOME/.ssh/id_rsa' },
      CWD,
      context,
    )
    expect(askMessage(expansion)).toContain('Shell expansion')

    const tilde = checkPathConstraints(
      { command: 'cat ~root/.ssh/id_rsa' },
      CWD,
      context,
    )
    expect(askMessage(tilde)).toContain('Tilde expansion')
  })

  // A write inside the working directory is only auto-allowed under acceptEdits.
  test('asks for a write inside the working directory outside acceptEdits mode', () => {
    expect(
      checkPathConstraints({ command: 'mkdir sub' }, CWD, allowingCwd())
        .behavior,
    ).toBe('ask')
  })

  // Paths are resolved against the original cwd, so a `cd` earlier in the
  // compound command makes every resolved write path wrong.
  test('asks for a write in a compound command that also changes directory', () => {
    const allowed = allowingCwd('acceptEdits')
    expect(
      checkPathConstraints({ command: 'mkdir sub' }, CWD, allowed).behavior,
    ).toBe('passthrough')
    const withCd = checkPathConstraints(
      { command: 'mkdir sub' },
      CWD,
      allowed,
      true,
    )
    expect(askMessage(withCd)).toContain('change directories')
  })

  test('passes through a plain read inside an allowed working directory', () => {
    expect(
      checkPathConstraints({ command: 'ls' }, CWD, allowingCwd()).behavior,
    ).toBe('passthrough')
  })
})
