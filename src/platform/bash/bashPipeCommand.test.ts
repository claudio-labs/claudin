import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'

import { rearrangePipeCommand } from 'src/platform/bash/bashPipeCommand.js'

// What the provider hands to `eval` for a piped command (bashProvider.ts). The
// end-to-end cases — the census commands, run through a real bash — are in
// src/platform/shell/bashProvider.test.ts; these pin the quoting itself.

const evalIn = (quoted: string, env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', `eval ${quoted}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

describe('rearrangePipeCommand', () => {
  test('sends the command byte for byte, single-quoted, with the redirect on eval', () => {
    expect(rearrangePipeCommand('ls ~/.cache | wc -l')).toBe("'ls ~/.cache | wc -l' < /dev/null")
  })

  test("closes and reopens around an embedded single quote, so ! stays a !", () => {
    const quoted = rearrangePipeCommand("echo 'select(.a != .b)' | cat")
    expect(quoted).toBe(`'echo '"'"'select(.a != .b)'"'"' | cat' < /dev/null`)
    expect(evalIn(quoted).stdout).toBe('select(.a != .b)\n')
  })

  test('bash expands what the command asks for: ~, braces, globs and variables', () => {
    const out = evalIn(rearrangePipeCommand('echo ~ {a,b} $GREETING | cat'), {
      HOME: '/home/someone',
      GREETING: 'hi',
    })
    expect(out.stdout).toBe('/home/someone a b hi\n')
  })
})
