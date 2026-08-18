import { describe, expect, test } from 'bun:test'

import {
  type CollectSignalsDeps,
  collectSignals,
  parsePackageScripts,
  renderSignals,
} from 'src/commands/auto-mode-setup/collectSignals.js'

function makeDeps(overrides: Partial<CollectSignalsDeps> = {}): CollectSignalsDeps {
  return {
    cwd: '/home/dev/project',
    homeDir: '/home/dev',
    readTextFile: async () => null,
    listDir: async () => [],
    git: async () => null,
    listSessionFiles: async () => [],
    tail: async () => '',
    readMounts: async () => null,
    ...overrides,
  }
}

const baseOptions = {
  posture: 'work' as const,
  includeShellHistory: false,
  permissionsAllow: [],
}

describe('collectSignals — shell history', () => {
  const history = [
    'git status',
    'export ANTHROPIC_API_KEY=sk-ant-0123456789abcdef',
    'bun test src/permissions/autoModeRules.test.ts',
    'psql postgres://admin:hunter2@db.internal:5432/prod',
    'git status',
    'curl -H "Authorization: Bearer sk-live-secret" https://api.example.com/v1/customers',
    'ssh deploy@10.0.0.4',
  ].join('\n')

  test('reduces history to counted command heads and leaks no argument text', async () => {
    const signals = await collectSignals(
      { ...baseOptions, includeShellHistory: true },
      makeDeps({
        tail: async path => (path.endsWith('.zsh_history') ? history : ''),
      }),
    )

    expect(signals.shellHistory.skipped).toBeNull()
    expect(signals.shellHistory.commands).toContainEqual({
      command: 'git status',
      count: 2,
    })
    expect(signals.shellHistory.commands).toContainEqual({
      command: 'bun test',
      count: 1,
    })

    // The payload the model receives must not carry a single argument.
    const payload = renderSignals(signals)
    for (const secret of [
      'sk-ant-0123456789abcdef',
      'hunter2',
      'sk-live-secret',
      'db.internal',
      'api.example.com',
      'deploy@10.0.0.4',
      'src/permissions/autoModeRules.test.ts',
      'ANTHROPIC_API_KEY',
    ]) {
      expect(payload).not.toContain(secret)
    }
  })

  test('does not read history unless it was requested', async () => {
    const readPaths: string[] = []
    const signals = await collectSignals(
      baseOptions,
      makeDeps({
        tail: async path => {
          readPaths.push(path)
          return history
        },
      }),
    )
    expect(signals.shellHistory).toEqual({
      commands: [],
      skipped: 'not requested',
    })
    expect(readPaths.some(p => p.includes('history'))).toBe(false)
  })

  test('skips history when the home directory is on a network filesystem', async () => {
    const signals = await collectSignals(
      { ...baseOptions, includeShellHistory: true },
      makeDeps({
        homeDir: '/net/home/dev',
        readMounts: async () =>
          'server:/export /net/home nfs4 rw,relatime 0 0\n/dev/sda1 / ext4 rw 0 0',
        tail: async () => history,
      }),
    )
    expect(signals.shellHistory.commands).toEqual([])
    expect(signals.shellHistory.skipped).toContain('network')
  })

  test('reports when no history file exists', async () => {
    const signals = await collectSignals(
      { ...baseOptions, includeShellHistory: true },
      makeDeps(),
    )
    expect(signals.shellHistory.skipped).toBe('no shell history file found')
  })
})

describe('collectSignals — sessions', () => {
  const transcript = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'bun run build' } },
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/home/dev/project/secret-plan.md' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'AWS_SECRET_ACCESS_KEY=abc aws s3 cp ./dump s3://bucket' },
          },
        ],
      },
    }),
    '{ truncated line',
  ].join('\n')

  test('counts tools and command heads without copying inputs', async () => {
    const signals = await collectSignals(
      baseOptions,
      makeDeps({
        listSessionFiles: async () => ['/sessions/a.jsonl'],
        tail: async () => transcript,
      }),
    )

    expect(signals.sessions.filesScanned).toBe(1)
    expect(signals.sessions.tools).toContainEqual({ command: 'Bash', count: 2 })
    expect(signals.sessions.tools).toContainEqual({ command: 'Read', count: 1 })
    expect(signals.sessions.commands).toContainEqual({
      command: 'bun run',
      count: 1,
    })
    expect(signals.sessions.commands).toContainEqual({
      command: 'aws s3',
      count: 1,
    })

    const payload = renderSignals(signals)
    expect(payload).not.toContain('secret-plan.md')
    expect(payload).not.toContain('s3://bucket')
    expect(payload).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  test('caps how many session files are opened', async () => {
    const opened: string[] = []
    await collectSignals(
      baseOptions,
      makeDeps({
        listSessionFiles: async () =>
          Array.from({ length: 40 }, (_, i) => `/sessions/${i}.jsonl`),
        tail: async path => {
          opened.push(path)
          return transcript
        },
      }),
    )
    expect(opened.length).toBeLessThanOrEqual(12)
  })
})

describe('collectSignals — project and repo', () => {
  test('reads the instructions file, lockfiles, scripts and config names', async () => {
    const signals = await collectSignals(
      baseOptions,
      makeDeps({
        listDir: async path =>
          path.endsWith('.git/hooks')
            ? ['pre-commit', 'pre-push.sample']
            : [
                'AGENTS.md',
                'package.json',
                'bun.lock',
                '.env',
                'tsconfig.json',
                'src',
              ],
        readTextFile: async path => {
          if (path.endsWith('AGENTS.md')) return '# Project rules\nUse bun.'
          if (path.endsWith('package.json')) {
            return JSON.stringify({ scripts: { build: 'bun run build.ts' } })
          }
          return null
        },
        git: async args => {
          if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
            return 'true\n'
          }
          if (args[0] === 'remote') return 'git@github.com:acme/project.git\n'
          if (args[0] === 'rev-parse') return 'main\n'
          return null
        },
      }),
    )

    expect(signals.project.instructionsFile).toBe('AGENTS.md')
    expect(signals.project.instructionsExcerpt).toContain('Use bun.')
    expect(signals.project.packageManagers).toEqual(['bun'])
    expect(signals.project.scripts).toEqual([
      { name: 'build', command: 'bun run build.ts' },
    ])
    expect(signals.project.configFileNames).toContain('.env')
    expect(signals.project.configFileNames).toContain('tsconfig.json')
    expect(signals.project.configFileNames).not.toContain('src')

    expect(signals.repo).toEqual({
      isGitRepo: true,
      remote: 'git@github.com:acme/project.git',
      currentBranch: 'main',
      hasCustomHooks: true,
    })
  })

  test('reports a non-git directory without calling further git commands', async () => {
    const calls: string[][] = []
    const signals = await collectSignals(
      baseOptions,
      makeDeps({
        git: async args => {
          calls.push(args)
          return null
        },
      }),
    )
    expect(signals.repo.isGitRepo).toBe(false)
    expect(calls).toEqual([['rev-parse', '--is-inside-work-tree']])
  })
})

describe('parsePackageScripts', () => {
  test('returns nothing for malformed or scriptless package.json', () => {
    expect(parsePackageScripts(null)).toEqual([])
    expect(parsePackageScripts('{ not json')).toEqual([])
    expect(parsePackageScripts('{"name":"x"}')).toEqual([])
  })

  test('truncates a very long script command', () => {
    const long = 'x'.repeat(500)
    const [script] = parsePackageScripts(
      JSON.stringify({ scripts: { build: long } }),
    )
    expect(script?.command.length).toBe(120)
  })
})

describe('renderSignals', () => {
  test('includes the always-allow rules the user accumulated', async () => {
    const signals = await collectSignals(
      { ...baseOptions, permissionsAllow: ['Bash(bun test:*)'] },
      makeDeps(),
    )
    expect(renderSignals(signals)).toContain('Bash(bun test:*)')
  })
})
