/**
 * The auto-mode dangerous-rule detectors.
 *
 * These decide which allow rules get stripped before the classifier runs. The
 * failure mode is one-directional and silent: a detector that stops
 * recognising `Bash(python:*)` leaves that rule in place and auto mode
 * auto-approves `python -c '<anything>'` without the classifier ever seeing it.
 * So each pattern SHAPE is pinned positively, and the near misses are pinned
 * negatively so a "fix" that widens the match to every `python*`-looking rule
 * is also caught.
 *
 * Everything here is pure: no settings, no provider, no feature gate.
 */
import { describe, expect, test } from 'bun:test'
import type { PermissionRule } from 'src/permissions/PermissionRule.js'
import {
  findDangerousClassifierPermissions,
  isDangerousBashPermission,
  isDangerousPowerShellPermission,
  isDangerousTaskPermission,
} from 'src/permissions/permissionSetup.js'

describe('isDangerousBashPermission', () => {
  test('a tool-level allow with no content allows every command', () => {
    expect(isDangerousBashPermission('Bash', undefined)).toBe(true)
    expect(isDangerousBashPermission('Bash', '')).toBe(true)
  })

  test('a standalone wildcard allows every command', () => {
    expect(isDangerousBashPermission('Bash', '*')).toBe(true)
  })

  test.each([
    ['exact interpreter name', 'python'],
    ['prefix syntax', 'python:*'],
    ['trailing wildcard', 'python*'],
    ['space wildcard', 'python *'],
    ['flag wildcard', 'python -*'],
    ['flag wildcard with a flag letter', 'python -c*'],
  ])('%s is dangerous (%s)', (_label, content) => {
    expect(isDangerousBashPermission('Bash', content)).toBe(true)
  })

  test('matching is case-insensitive and ignores surrounding whitespace', () => {
    expect(isDangerousBashPermission('Bash', 'PYTHON:*')).toBe(true)
    expect(isDangerousBashPermission('Bash', '  node:*  ')).toBe(true)
  })

  test('a multi-word package runner matches on the whole phrase', () => {
    expect(isDangerousBashPermission('Bash', 'npm run:*')).toBe(true)
    expect(isDangerousBashPermission('Bash', 'bun run:*')).toBe(true)
  })

  test.each([
    ['a longer command that merely starts with an interpreter', 'pythonic:*'],
    ['an interpreter in a non-leading position', 'echo python:*'],
    ['a prefix without the wildcard', 'python:'],
    ['a fully-specified command', 'python -c "print(1)"'],
    ['a different npm subcommand', 'npm install:*'],
    ['an ordinary read-only command', 'git status:*'],
    ['a wildcard on an unrelated command', 'ls *'],
  ])('%s is NOT dangerous (%s)', (_label, content) => {
    expect(isDangerousBashPermission('Bash', content)).toBe(false)
  })

  test('the predicate only speaks for Bash rules', () => {
    expect(isDangerousBashPermission('Read', undefined)).toBe(false)
    expect(isDangerousBashPermission('PowerShell', 'python:*')).toBe(false)
  })
})

describe('isDangerousPowerShellPermission', () => {
  test('a tool-level allow with no content allows every command', () => {
    expect(isDangerousPowerShellPermission('PowerShell', undefined)).toBe(true)
    expect(isDangerousPowerShellPermission('PowerShell', '')).toBe(true)
    expect(isDangerousPowerShellPermission('PowerShell', '*')).toBe(true)
  })

  test.each([
    ['the Invoke-Expression alias', 'iex:*'],
    ['Invoke-Expression spelled out', 'invoke-expression:*'],
    ['the Invoke-Command alias', 'icm:*'],
    ['a process spawner', 'start-process:*'],
    ['a job spawner', 'start-job:*'],
    ['a remote session', 'enter-pssession:*'],
    ['an event registration', 'register-objectevent:*'],
    ['the .NET escape hatch', 'add-type:*'],
    ['the COM escape hatch', 'new-object:*'],
    ['a nested shell', 'pwsh:*'],
    ['a cross-platform interpreter shared with bash', 'python:*'],
  ])('%s is dangerous (%s)', (_label, content) => {
    expect(isDangerousPowerShellPermission('PowerShell', content)).toBe(true)
  })

  test('PowerShell rule content is matched case-insensitively', () => {
    expect(isDangerousPowerShellPermission('PowerShell', 'Start-Process:*')).toBe(
      true,
    )
    expect(isDangerousPowerShellPermission('PowerShell', 'IEX*')).toBe(true)
  })

  test('the .exe spelling of an interpreter is dangerous too', () => {
    expect(isDangerousPowerShellPermission('PowerShell', 'python.exe:*')).toBe(
      true,
    )
    expect(isDangerousPowerShellPermission('PowerShell', 'python.exe')).toBe(true)
    expect(isDangerousPowerShellPermission('PowerShell', 'python.exe -*')).toBe(
      true,
    )
  })

  test('.exe goes on the FIRST word of a multi-word runner', () => {
    expect(isDangerousPowerShellPermission('PowerShell', 'npm.exe run:*')).toBe(
      true,
    )
    // and not on the last word — `npm run.exe` is not a real invocation
    expect(isDangerousPowerShellPermission('PowerShell', 'npm run.exe:*')).toBe(
      false,
    )
  })

  test.each([
    ['a read-only cmdlet', 'get-childitem:*'],
    ['a cmdlet that merely starts with a dangerous prefix', 'start-sleep:*'],
    ['a different Invoke- cmdlet', 'invoke-webrequest:*'],
    ['a fully-specified command', 'start-process notepad.exe'],
    ['a dangerous name in a non-leading position', 'echo iex:*'],
  ])('%s is NOT dangerous (%s)', (_label, content) => {
    expect(isDangerousPowerShellPermission('PowerShell', content)).toBe(false)
  })

  test('the predicate only speaks for PowerShell rules', () => {
    expect(isDangerousPowerShellPermission('Bash', undefined)).toBe(false)
    expect(isDangerousPowerShellPermission('Bash', 'iex:*')).toBe(false)
  })
})

describe('isDangerousTaskPermission', () => {
  test('any Agent allow rule bypasses sub-agent evaluation', () => {
    expect(isDangerousTaskPermission('Agent', undefined)).toBe(true)
    expect(isDangerousTaskPermission('Agent', 'general-purpose')).toBe(true)
  })

  test('the legacy Task spelling normalizes to Agent and stays dangerous', () => {
    expect(isDangerousTaskPermission('Task', undefined)).toBe(true)
  })

  test('an unrelated tool is not an Agent rule', () => {
    expect(isDangerousTaskPermission('Bash', undefined)).toBe(false)
    expect(isDangerousTaskPermission('AgentOutput', undefined)).toBe(false)
  })
})

function allowRule(
  ruleString: string,
  source: PermissionRule['source'] = 'localSettings',
): PermissionRule {
  const open = ruleString.indexOf('(')
  return {
    source,
    ruleBehavior: 'allow',
    ruleValue:
      open === -1
        ? { toolName: ruleString }
        : {
            toolName: ruleString.slice(0, open),
            ruleContent: ruleString.slice(open + 1, -1),
          },
  }
}

describe('findDangerousClassifierPermissions', () => {
  test('finds a dangerous rule loaded from settings', () => {
    const found = findDangerousClassifierPermissions(
      [allowRule('Bash(python:*)')],
      [],
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.ruleDisplay).toBe('Bash(python:*)')
    expect(found[0]!.source).toBe('localSettings')
  })

  test('a rule with no content is displayed as Tool(*)', () => {
    const found = findDangerousClassifierPermissions([allowRule('Bash')], [])
    expect(found[0]!.ruleDisplay).toBe('Bash(*)')
  })

  test('a DENY rule for the same pattern is not dangerous', () => {
    const denied: PermissionRule = {
      ...allowRule('Bash(python:*)'),
      ruleBehavior: 'deny',
    }
    expect(findDangerousClassifierPermissions([denied], [])).toEqual([])
  })

  test('an ASK rule for the same pattern is not dangerous', () => {
    const asked: PermissionRule = {
      ...allowRule('Bash(python:*)'),
      ruleBehavior: 'ask',
    }
    expect(findDangerousClassifierPermissions([asked], [])).toEqual([])
  })

  test('a harmless allow rule is left alone', () => {
    expect(
      findDangerousClassifierPermissions([allowRule('Bash(git status:*)')], []),
    ).toEqual([])
  })

  test('all three tool families are checked, not just Bash', () => {
    const found = findDangerousClassifierPermissions(
      [
        allowRule('Bash(python:*)'),
        allowRule('PowerShell(iex:*)'),
        allowRule('Agent'),
        allowRule('Read(**)'),
      ],
      [],
    )
    expect(found.map(f => f.ruleDisplay)).toEqual([
      'Bash(python:*)',
      'PowerShell(iex:*)',
      'Agent(*)',
    ])
  })

  test('a CLI --allowed-tools entry is reported against the cliArg source', () => {
    const found = findDangerousClassifierPermissions([], ['Bash(python:*)'])
    expect(found).toHaveLength(1)
    expect(found[0]!.source).toBe('cliArg')
    expect(found[0]!.sourceDisplay).toBe('--allowed-tools')
    expect(found[0]!.ruleDisplay).toBe('Bash(python:*)')
    expect(found[0]!.ruleValue).toEqual({
      toolName: 'Bash',
      ruleContent: 'python:*',
    })
  })

  test('a bare CLI tool name is a tool-wide allow', () => {
    const found = findDangerousClassifierPermissions([], ['Bash'])
    expect(found).toHaveLength(1)
    expect(found[0]!.ruleDisplay).toBe('Bash(*)')
    expect(found[0]!.ruleValue).toEqual({
      toolName: 'Bash',
      ruleContent: undefined,
    })
  })

  test('whitespace inside a CLI spec is trimmed before matching', () => {
    const found = findDangerousClassifierPermissions([], ['Bash ( python:* )'])
    expect(found).toHaveLength(1)
    expect(found[0]!.ruleValue).toEqual({
      toolName: 'Bash',
      ruleContent: 'python:*',
    })
  })

  test('a harmless CLI spec is left alone', () => {
    expect(
      findDangerousClassifierPermissions([], ['Read', 'Bash(git status:*)']),
    ).toEqual([])
  })

  test('a CLI spec that does not parse is skipped rather than guessed at', () => {
    // The `$` anchor is what makes this a non-match. Without it the spec would
    // parse as Bash(python:*) plus trailing garbage and be honoured.
    expect(
      findDangerousClassifierPermissions([], ['Bash(python:*)(x)']),
    ).toEqual([])
  })

  test('settings rules and CLI specs are both reported, settings first', () => {
    const found = findDangerousClassifierPermissions(
      [allowRule('Agent')],
      ['Bash'],
    )
    expect(found.map(f => f.source)).toEqual(['localSettings', 'cliArg'])
  })
})
