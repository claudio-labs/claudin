import { describe, expect, test } from 'bun:test'
import { detectLauncherFailure } from 'src/tools/shared/diagnostics/launcherFailure.js'

/** What the tools see: the shell's own bytes, not a string someone believed it prints. */
function shell(command: string, shellBin = 'bash'): { stdout: string; stderr: string; exitCode: number } {
  const run = Bun.spawnSync([shellBin, '-c', command])
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), exitCode: run.exitCode ?? 1 }
}

describe('detectLauncherFailure', () => {
  test('a command bash could not find', () => {
    const run = shell('pyright-definitely-not-installed --outputjson')
    expect(run.exitCode).toBe(127)
    expect(detectLauncherFailure(run)).toBe('`pyright-definitely-not-installed` is not installed or not on PATH')
  })

  test('the same through sh, whose wording differs', () => {
    const run = shell('pyright-definitely-not-installed', 'sh')
    expect(detectLauncherFailure(run)).toBe('`pyright-definitely-not-installed` is not installed or not on PATH')
  })

  test.skipIf(!Bun.which('zsh'))('the same through zsh, which puts the name last', () => {
    const run = shell('pyright-definitely-not-installed', 'zsh')
    expect(detectLauncherFailure(run)).toBe('`pyright-definitely-not-installed` is not installed or not on PATH')
  })

  test("dash's wording, as a Makefile recipe meets a missing tool", () => {
    const stderr = '/bin/sh: 1: protoc: not found\nmake: *** [Makefile:3: all] Error 127\n'
    expect(detectLauncherFailure({ stdout: '', stderr, exitCode: 2 })).toBe('`protoc` is not installed or not on PATH')
  })

  test('a mise shim with no version selected', () => {
    // Verbatim from the 2026-10-08 legendarr session: exit 1, not 127, and three
    // ERROR lines the scrape counted as type errors.
    const stderr = [
      'mise ERROR No version is set for shim: pyright',
      'Set a global default version with one of the following:',
      'mise use -g node@25.9.0',
      'mise ERROR Version: 2026.10.0 linux-x64 (2026-10-02)',
      'mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information',
    ].join('\n')
    expect(detectLauncherFailure({ stdout: '', stderr, exitCode: 1 })).toBe(
      'the `pyright` shim has no version selected (mise/asdf)',
    )
  })

  test('an asdf shim with no version selected', () => {
    const stderr = 'No version is set for command pytest\nConsider adding one of the following versions in your config file at /home/u/.tool-versions\n'
    expect(detectLauncherFailure({ stdout: '', stderr, exitCode: 126 })).toContain('the `pytest` shim')
  })

  test('exit 127 with nothing recognisable still means not found', () => {
    expect(detectLauncherFailure({ stdout: '', stderr: '', exitCode: 127 })).toBe('the command was not found (exit 127)')
  })

  test('a tool that ran and failed is not a launcher failure', () => {
    const stdout = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
    expect(detectLauncherFailure({ stdout, stderr: '', exitCode: 2 })).toBeNull()
    // A tool reporting a missing FILE or LIBRARY is the tool talking, not the shell.
    expect(detectLauncherFailure({ stdout: 'Error: config.yaml: not found\n', stderr: '', exitCode: 1 })).toBeNull()
    expect(detectLauncherFailure({ stdout: 'ld: library not found for -lssl\n', stderr: '', exitCode: 1 })).toBeNull()
  })

  test('a clean exit is never a launcher failure, whatever it printed', () => {
    expect(detectLauncherFailure({ stdout: 'bash: x: command not found\n', stderr: '', exitCode: 0 })).toBeNull()
  })
})
