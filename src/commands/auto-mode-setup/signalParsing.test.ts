import { describe, expect, test } from 'bun:test'

import {
  buildHistogram,
  extractCommandHead,
  extractToolUsesFromTranscript,
  isNetworkHome,
  parseShellHistory,
} from 'src/commands/auto-mode-setup/signalParsing.js'

describe('extractCommandHead', () => {
  test('keeps the binary and a bare subcommand', () => {
    expect(extractCommandHead('git status')).toBe('git status')
    expect(extractCommandHead('bun run build')).toBe('bun run')
    expect(extractCommandHead('docker compose up -d')).toBe('docker compose')
  })

  test('drops flags, paths, urls and everything else after the head', () => {
    expect(extractCommandHead('git commit -m "fix the login bug"')).toBe(
      'git commit',
    )
    expect(extractCommandHead('curl https://api.example.com/secret')).toBe(
      'curl',
    )
    expect(extractCommandHead('bun test src/private/file.test.ts')).toBe(
      'bun test',
    )
  })

  test('strips environment assignments before reading the binary', () => {
    expect(extractCommandHead('API_KEY=sk-live-1234 node server.js')).toBe(
      'node',
    )
  })

  test('reports only the basename of a binary given by path', () => {
    expect(extractCommandHead('/usr/local/bin/git push')).toBe('git push')
    expect(extractCommandHead('./scripts/private-deploy.sh')).toBeNull()
  })

  test('drops a binary that is not on the reportable list', () => {
    expect(extractCommandHead('acme-internal-cli deploy')).toBeNull()
    expect(extractCommandHead('')).toBeNull()
    expect(extractCommandHead('   ')).toBeNull()
  })

  test('describes only the head of a pipeline', () => {
    expect(extractCommandHead('git log | grep secret-branch')).toBe('git log')
    expect(extractCommandHead('cat /etc/shadow && rm -rf /')).toBe('cat')
  })

  test('never reads past the first segment for the binary', () => {
    // The segment is `FOO=bar`, which names no command — reporting `git` here
    // would mean describing a command the user did not run in that position.
    expect(extractCommandHead('FOO=bar; git status')).toBeNull()
  })

  test('reports a bare argument only for binaries that take subcommands', () => {
    // `git status` is a subcommand; `cd my-client-repo` and `which acme-cli`
    // would be names from this machine, so only the binary is reported.
    expect(extractCommandHead('cd my-client-repo')).toBe('cd')
    expect(extractCommandHead('which acme-internal-cli')).toBe('which')
    expect(extractCommandHead('kill 4242')).toBe('kill')
    expect(extractCommandHead('docker compose up')).toBe('docker compose')
  })
})

describe('parseShellHistory', () => {
  test('reads plain bash history', () => {
    expect(parseShellHistory('git status\nbun test\n')).toEqual([
      'git status',
      'bun test',
    ])
  })

  test('strips the zsh extended-history prefix', () => {
    expect(parseShellHistory(': 1699999999:0;git status')).toEqual([
      'git status',
    ])
  })

  test('reads fish history entries and ignores its metadata lines', () => {
    expect(parseShellHistory('- cmd: git status\n  when: 1699999999')).toEqual([
      'git status',
    ])
  })
})

describe('buildHistogram', () => {
  test('orders by count then name, and applies the limit', () => {
    const histogram = buildHistogram(
      ['git status', 'bun test', 'git status', 'ls', null],
      2,
    )
    expect(histogram).toEqual([
      { command: 'git status', count: 2 },
      { command: 'bun test', count: 1 },
    ])
  })
})

describe('isNetworkHome', () => {
  const mounts = [
    '/dev/sda1 / ext4 rw 0 0',
    'server:/export /net/home nfs4 rw 0 0',
    '/dev/sdb1 /home ext4 rw 0 0',
  ].join('\n')

  test('detects a home on a network mount', () => {
    expect(isNetworkHome(mounts, '/net/home/dev')).toBe(true)
  })

  test('accepts a local home', () => {
    expect(isNetworkHome(mounts, '/home/dev')).toBe(false)
    expect(isNetworkHome(null, '/home/dev')).toBe(false)
  })

  test('treats a UNC path as network', () => {
    expect(isNetworkHome(null, '\\\\fileserver\\users\\dev')).toBe(true)
  })
})

describe('extractToolUsesFromTranscript', () => {
  test('ignores lines that are not JSON objects', () => {
    const result = extractToolUsesFromTranscript('not json\n[]\n{ broken')
    expect(result.toolNames).toEqual([])
    expect(result.commandHeads).toEqual([])
  })

  test('reads tool names and shell heads only', () => {
    const line = JSON.stringify({
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'git push origin main' } },
          { type: 'text', text: 'ignored' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/secret' } },
        ],
      },
    })
    const result = extractToolUsesFromTranscript(line)
    expect(result.toolNames).toEqual(['Bash', 'Edit'])
    expect(result.commandHeads).toEqual(['git push'])
  })
})
