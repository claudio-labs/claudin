/**
 * Characterization of dangerous-rule detection: which allow rules would let
 * the model run arbitrary code (or spawn a sub-agent) before the auto-mode
 * classifier sees the action, and how each finding is described.
 *
 * Detection goes through the permissionSetup barrel, the way every caller but
 * the stash reaches it. The two name lists come from dangerousPatterns.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  getCwdState,
  getFlagSettingsPath,
  getOriginalCwd,
  setCwdState,
  setFlagSettingsPath,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from 'src/permissions/dangerousPatterns.js'
import type { PermissionRule, PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import {
  findDangerousClassifierPermissions,
  isDangerousBashPermission,
  isDangerousPowerShellPermission,
  isDangerousTaskPermission,
} from 'src/permissions/permissionSetup.js'

const INTERPRETERS = ['python', 'python3', 'python2', 'node', 'deno', 'tsx', 'ruby', 'perl', 'php', 'lua']
const RUNNERS = ['npx', 'bunx', 'npm run', 'yarn run', 'pnpm run', 'bun run']
const SHARED_SHELLS = ['bash', 'sh', 'ssh']
const BASH_ONLY = ['zsh', 'fish', 'eval', 'exec', 'env', 'xargs', 'sudo']
const POWERSHELL_ONLY = [
  'pwsh', 'powershell', 'cmd', 'wsl',
  'iex', 'invoke-expression', 'icm', 'invoke-command',
  'start-process', 'saps', 'start', 'start-job', 'sajb', 'start-threadjob',
  'register-objectevent', 'register-engineevent', 'register-wmievent', 'register-scheduledjob',
  'new-pssession', 'nsn', 'enter-pssession', 'etsn',
  'add-type', 'new-object',
]

/** Every rule body a name is caught under. */
function shapes(name: string): string[] {
  return [name, `${name}:*`, `${name}*`, `${name} *`, `${name} -c*`, `${name} --eval *`]
}

describe('the exported name lists', () => {
  test('cross-platform code execution entry points, in order', () => {
    expect([...CROSS_PLATFORM_CODE_EXEC] as string[]).toEqual([...INTERPRETERS, ...RUNNERS, ...SHARED_SHELLS])
  })

  test('the Bash list is the shared list plus the Unix-only names', () => {
    expect([...DANGEROUS_BASH_PATTERNS]).toEqual([...INTERPRETERS, ...RUNNERS, ...SHARED_SHELLS, ...BASH_ONLY])
  })
})

describe('Bash rules', () => {
  test('a tool-wide rule is dangerous: no body, an empty body, or a lone star', () => {
    for (const body of [undefined, '', '*', '  *  ']) {
      expect(isDangerousBashPermission('Bash', body)).toBe(true)
    }
  })

  for (const name of DANGEROUS_BASH_PATTERNS) {
    test(`"${name}" is caught in every rule shape`, () => {
      for (const body of shapes(name)) {
        expect(isDangerousBashPermission('Bash', body)).toBe(true)
      }
    })
  }

  test('the body is trimmed and lowercased before comparing', () => {
    for (const body of ['  python:*  ', 'PYTHON:*', 'Node *', 'NPM RUN:*', '\tsudo\n']) {
      expect(isDangerousBashPermission('Bash', body)).toBe(true)
    }
  })

  test('only the Bash tool is judged', () => {
    for (const tool of ['PowerShell', 'bash', 'Read', 'Agent']) {
      expect(isDangerousBashPermission(tool, undefined)).toBe(false)
      expect(isDangerousBashPermission(tool, 'python:*')).toBe(false)
    }
  })

  const safe: Array<[body: string, why: string]> = [
    ['python script.py', 'an exact command with an argument'],
    ['python -c print(1)', 'a dash argument with no trailing star'],
    ['python3.12:*', 'a version suffix is a different word'],
    ['/usr/bin/python:*', 'an absolute path is a different word'],
    ['pythonx', 'a look-alike word'],
    ['npm:*', 'only "npm run" is listed, not npm'],
    ['npm install:*', 'another npm subcommand'],
    ['git:*', 'not an interpreter on the list'],
    ['ls *', 'not an interpreter on the list'],
    ['p*', 'a wildcard broader than the name is not recognised'],
    ['* *', 'neither is a catch-all with a space'],
    ['**', 'nor a double star'],
    ['timeout:*', 'wrappers are not on the list'],
    ['nohup *', 'wrappers are not on the list'],
    ['pwsh:*', 'PowerShell-only names do not count for Bash'],
    ['iex:*', 'PowerShell-only names do not count for Bash'],
    ['python.exe:*', 'the .exe spelling is a PowerShell rule shape only'],
  ]
  for (const [body, why] of safe) {
    test(`not dangerous: Bash(${body}) (${why})`, () => {
      expect(isDangerousBashPermission('Bash', body)).toBe(false)
    })
  }
})

describe('PowerShell rules', () => {
  test('a tool-wide rule is dangerous: no body, an empty body, or a lone star', () => {
    for (const body of [undefined, '', '*', ' * ']) {
      expect(isDangerousPowerShellPermission('PowerShell', body)).toBe(true)
    }
  })

  for (const name of [...CROSS_PLATFORM_CODE_EXEC, ...POWERSHELL_ONLY]) {
    test(`"${name}" is caught in every rule shape, with and without .exe`, () => {
      const space = name.indexOf(' ')
      const exe = space === -1 ? `${name}.exe` : `${name.slice(0, space)}.exe${name.slice(space)}`
      for (const body of [...shapes(name), ...shapes(exe)]) {
        expect(isDangerousPowerShellPermission('PowerShell', body)).toBe(true)
      }
    })
  }

  test('cmdlet names are matched case-insensitively', () => {
    for (const body of ['Invoke-Expression:*', 'Start-Process *', 'IEX', 'Add-Type -TypeDefinition*', 'NPM.EXE RUN:*']) {
      expect(isDangerousPowerShellPermission('PowerShell', body)).toBe(true)
    }
  })

  test('only the PowerShell tool is judged', () => {
    for (const tool of ['Bash', 'powershell', 'Agent']) {
      expect(isDangerousPowerShellPermission(tool, undefined)).toBe(false)
      expect(isDangerousPowerShellPermission(tool, 'iex:*')).toBe(false)
    }
  })

  const safe: Array<[body: string, why: string]> = [
    ['Get-ChildItem:*', 'an ordinary cmdlet'],
    ['start-sleep:*', 'a look-alike of "start"'],
    ['npm.exe:*', 'only "npm run" is listed'],
    ['python.exe script.py', 'an exact command'],
    ['sudo:*', 'Unix-only names do not count for PowerShell'],
    ['zsh *', 'Unix-only names do not count for PowerShell'],
    ['i*', 'a wildcard broader than the name is not recognised'],
  ]
  for (const [body, why] of safe) {
    test(`not dangerous: PowerShell(${body}) (${why})`, () => {
      expect(isDangerousPowerShellPermission('PowerShell', body)).toBe(false)
    })
  }
})

describe('sub-agent rules', () => {
  test('any Agent rule is dangerous, whatever its body, under the current or legacy name', () => {
    for (const tool of ['Agent', 'Task']) {
      for (const body of [undefined, '', '*', 'Explore', 'general-purpose']) {
        expect(isDangerousTaskPermission(tool, body)).toBe(true)
      }
    }
  })

  test('no other tool is', () => {
    for (const tool of ['agent', 'task', 'Bash', 'TaskOutput', 'SendMessage']) {
      expect(isDangerousTaskPermission(tool, undefined)).toBe(false)
    }
  })
})

describe('scanning loaded rules and --allowed-tools', () => {
  let root: string
  let project: string
  const saved = {
    env: process.env.CLAUDIN_CONFIG_DIR,
    original: getOriginalCwd(),
    cwd: getCwdState(),
    flag: getFlagSettingsPath(),
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'shellrules-dangerous-')))
    project = join(root, 'project')
    mkdirSync(project)
    mkdirSync(join(root, 'config'))
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    setOriginalCwd(project)
    setCwdState(project)
    setFlagSettingsPath(undefined)
  })

  afterEach(() => {
    if (saved.env === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = saved.env
    setOriginalCwd(saved.original)
    setCwdState(saved.cwd)
    setFlagSettingsPath(saved.flag)
    rmSync(root, { recursive: true, force: true })
  })

  function rule(
    source: PermissionRuleSource,
    toolName: string,
    ruleContent?: string,
    ruleBehavior: PermissionRule['ruleBehavior'] = 'allow',
  ): PermissionRule {
    return { source, ruleBehavior, ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent } }
  }

  test('nothing in, nothing out', () => {
    expect(findDangerousClassifierPermissions([], [])).toEqual([])
  })

  test('only allow rules are reported, and safe ones are skipped', () => {
    const found = findDangerousClassifierPermissions(
      [
        rule('session', 'Bash', 'python:*', 'deny'),
        rule('session', 'Bash', 'python:*', 'ask'),
        rule('session', 'Bash', 'ls:*'),
        rule('session', 'Read'),
        rule('session', 'Bash', 'node *'),
      ],
      [],
    )
    expect(found.map(f => f.ruleDisplay)).toEqual(['Bash(node *)'])
  })

  test('a loaded rule keeps its value and source; its display is Tool(body), or Tool(*) when tool-wide', () => {
    const found = findDangerousClassifierPermissions(
      [rule('session', 'Bash'), rule('cliArg', 'Agent', 'Explore'), rule('command', 'PowerShell', 'iex:*')],
      [],
    )
    expect(found).toEqual([
      { ruleValue: { toolName: 'Bash' }, source: 'session', ruleDisplay: 'Bash(*)', sourceDisplay: 'session' },
      {
        ruleValue: { toolName: 'Agent', ruleContent: 'Explore' },
        source: 'cliArg',
        ruleDisplay: 'Agent(Explore)',
        sourceDisplay: 'cliArg',
      },
      {
        ruleValue: { toolName: 'PowerShell', ruleContent: 'iex:*' },
        source: 'command',
        ruleDisplay: 'PowerShell(iex:*)',
        sourceDisplay: 'command',
      },
    ])
  })

  test('a settings source is shown as its file, relative to the working directory when that is shorter', () => {
    const found = findDangerousClassifierPermissions(
      [
        rule('projectSettings', 'Bash', 'python:*'),
        rule('localSettings', 'Bash', 'python:*'),
        rule('userSettings', 'Bash', 'python:*'),
      ],
      [],
    )
    expect(found.map(f => f.sourceDisplay)).toEqual([
      join('.claudin', 'settings.json'),
      join('.claudin', 'settings.local.json'),
      join('..', 'config', 'settings.json'),
    ])
  })

  test('the working directory used for the relative path is the current one', () => {
    const deeper = join(project, 'a', 'b')
    mkdirSync(deeper, { recursive: true })
    setCwdState(deeper)
    const [found] = findDangerousClassifierPermissions([rule('projectSettings', 'Bash')], [])
    expect(found!.sourceDisplay).toBe(join('..', '..', '.claudin', 'settings.json'))
  })

  test('the managed file is shown absolute when the relative form is longer', () => {
    const [found] = findDangerousClassifierPermissions([rule('policySettings', 'Bash', 'sudo:*')], [])
    expect(isAbsolute(found!.sourceDisplay)).toBe(true)
    expect(found!.sourceDisplay.endsWith('managed-settings.json')).toBe(true)
  })

  test('flag settings show the --settings file, or the source name when there is none', () => {
    const [without] = findDangerousClassifierPermissions([rule('flagSettings', 'Bash')], [])
    expect(without!.sourceDisplay).toBe('flagSettings')

    setFlagSettingsPath(join(project, 'extra.json'))
    const [withPath] = findDangerousClassifierPermissions([rule('flagSettings', 'Bash')], [])
    expect(withPath!.sourceDisplay).toBe('extra.json')
  })

  test('--allowed-tools entries are reported after the loaded rules, as cliArg from "--allowed-tools"', () => {
    const found = findDangerousClassifierPermissions(
      [rule('session', 'Bash', 'sudo:*')],
      ['Read', 'Bash(python:*)', 'Bash', 'Agent', 'Bash(ls)', 'Task(Explore)', 'PowerShell(iex)'],
    )
    expect(found.slice(1)).toEqual([
      {
        ruleValue: { toolName: 'Bash', ruleContent: 'python:*' },
        source: 'cliArg',
        ruleDisplay: 'Bash(python:*)',
        sourceDisplay: '--allowed-tools',
      },
      { ruleValue: { toolName: 'Bash', ruleContent: undefined }, source: 'cliArg', ruleDisplay: 'Bash(*)', sourceDisplay: '--allowed-tools' },
      { ruleValue: { toolName: 'Agent', ruleContent: undefined }, source: 'cliArg', ruleDisplay: 'Agent(*)', sourceDisplay: '--allowed-tools' },
      {
        ruleValue: { toolName: 'Task', ruleContent: 'Explore' },
        source: 'cliArg',
        ruleDisplay: 'Task(Explore)',
        sourceDisplay: '--allowed-tools',
      },
      {
        ruleValue: { toolName: 'PowerShell', ruleContent: 'iex' },
        source: 'cliArg',
        ruleDisplay: 'PowerShell(iex)',
        sourceDisplay: '--allowed-tools',
      },
    ])
  })

  test('--allowed-tools: name and body are trimmed; an empty body is tool-wide; the display keeps the entry', () => {
    const found = findDangerousClassifierPermissions([], [' Bash ( python:* )', 'Bash()', 'Bash( * )'])
    expect(found).toEqual([
      {
        ruleValue: { toolName: 'Bash', ruleContent: 'python:*' },
        source: 'cliArg',
        ruleDisplay: ' Bash ( python:* )',
        sourceDisplay: '--allowed-tools',
      },
      { ruleValue: { toolName: 'Bash', ruleContent: '' }, source: 'cliArg', ruleDisplay: 'Bash(*)', sourceDisplay: '--allowed-tools' },
      { ruleValue: { toolName: 'Bash', ruleContent: '*' }, source: 'cliArg', ruleDisplay: 'Bash( * )', sourceDisplay: '--allowed-tools' },
    ])
  })

  test('--allowed-tools: tool names are case-sensitive', () => {
    expect(findDangerousClassifierPermissions([], ['bash', 'agent', 'powershell(iex)'])).toEqual([])
  })
})
