import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { getWindowsBashHookCommand } from 'src/platform/lifecycleHooks/windowsBashCommand.js'

describe('getWindowsBashHookCommand', () => {
  test('prepends bash to a bare .sh script', () => {
    expect(getWindowsBashHookCommand('./hook.sh')).toBe('bash ./hook.sh')
  })

  test('prepends bash when the script takes arguments', () => {
    expect(getWindowsBashHookCommand('./hook.sh --fast')).toBe('bash ./hook.sh --fast')
  })

  test('prepends bash to a quoted script path', () => {
    expect(getWindowsBashHookCommand('"C:/My Hooks/hook.sh"')).toBe('bash "C:/My Hooks/hook.sh"')
  })

  test('leaves a command that already starts with bash alone', () => {
    expect(getWindowsBashHookCommand('bash ./hook.sh')).toBe('bash ./hook.sh')
  })

  test('leaves a command with no .sh script alone', () => {
    expect(getWindowsBashHookCommand('node ./hook.js')).toBe('node ./hook.js')
    expect(getWindowsBashHookCommand('./hook.shell')).toBe('./hook.shell')
  })

  test('matches the .sh suffix in any case', () => {
    expect(getWindowsBashHookCommand('./hook.SH')).toBe('bash ./hook.SH')
  })

  test('puts bash after leading variable assignments', () => {
    expect(getWindowsBashHookCommand('FOO=1 ./hook.sh')).toBe('FOO=1 bash ./hook.sh')
  })

  test.each([
    `echo '{}' | ./hook.sh`,
    'cd hooks && ./hook.sh',
    'node build.js; ./hook.sh',
    'echo ./hook.sh',
  ])('leaves %s alone: its command word is not the script', command => {
    expect(getWindowsBashHookCommand(command)).toBe(command)
  })

  test('the hook runner applies it on the Windows bash path', () => {
    const runners = readFileSync(new URL('./runners.ts', import.meta.url), 'utf8')
    expect(runners).toContain('if (isWindows && !isPowerShell) {\n    command = getWindowsBashHookCommand(command)')
  })
})
