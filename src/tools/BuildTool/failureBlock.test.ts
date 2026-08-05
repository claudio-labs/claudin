import { describe, expect, test } from 'bun:test'
import { extractFailureBlock } from './failureBlock.js'
import { isUpToDate } from './noOp.js'

describe('extractFailureBlock', () => {
  test('takes the gradle what-went-wrong block and drops the help boilerplate', () => {
    const log = [
      '> Task :app:compileKotlin',
      'FAILURE: Build failed with an exception.',
      '',
      '* What went wrong:',
      "Could not resolve all files for configuration ':app:compileClasspath'.",
      '> Could not find com.example:missing:1.0.',
      '',
      '* Try:',
      '> Run with --stacktrace option to get the stack trace.',
      '* Get more help at https://help.gradle.org',
    ].join('\n')
    const block = extractFailureBlock('gradle', log)
    expect(block).toContain('Could not find com.example:missing:1.0.')
    expect(block).not.toContain('Get more help')
    expect(block).not.toContain('--stacktrace')
  })

  test('takes the LAST anchor, which is the failure that ended the run', () => {
    const log = [
      'FAILURE: Build failed with an exception.',
      'first attempt',
      'retrying',
      'FAILURE: Build failed with an exception.',
      'second attempt',
    ].join('\n')
    expect(extractFailureBlock('gradle', log)).toContain('second attempt')
    expect(extractFailureBlock('gradle', log)).not.toContain('first attempt')
  })

  test('drops the json cargo interleaves into its own prose summary', () => {
    // Captured live: `cargo build --message-format=json` still prints the human
    // summary on stderr, with the machine stream's last record right under it.
    const log = [
      '{"reason":"compiler-message","message":{}}',
      'error: could not compile `fix` (bin "fix") due to 1 previous error',
      '{"reason":"build-finished","success":false}',
    ].join('\n')
    const block = extractFailureBlock('cargo', log)
    expect(block).toBe('error: could not compile `fix` (bin "fix") due to 1 previous error')
  })

  test('reads the maven goal failure', () => {
    const log = [
      '[INFO] BUILD FAILURE',
      '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile',
      '[ERROR] Compilation failure',
      '[ERROR] -> [Help 1]',
    ].join('\n')
    const block = extractFailureBlock('maven', log)
    expect(block).toContain('maven-compiler-plugin')
    expect(block).not.toContain('[Help 1]')
  })

  test('reads a cargo linker failure, which carries no file:line', () => {
    const log = [
      '   Compiling app v0.1.0',
      'error: linking with `cc` failed: exit status: 1',
      '  = note: /usr/bin/ld: cannot find -lssl',
    ].join('\n')
    expect(extractFailureBlock('cargo', log)).toContain('cannot find -lssl')
  })

  test('reads the make failure line', () => {
    const log = ['cc -c main.c', "make: *** [Makefile:12: all] Error 2"].join('\n')
    expect(extractFailureBlock('make', log)).toContain('Error 2')
  })

  test('falls back to the failure-naming lines for an unknown system', () => {
    const log = ['building', 'oops: could not find the toolchain', 'done'].join('\n')
    expect(extractFailureBlock('unknown', log)).toBe('oops: could not find the toolchain')
  })

  test('the fallback leaves positioned lines to the diagnostic list', () => {
    const log = ['src/main.rs:4:9: error: mismatched types'].join('\n')
    expect(extractFailureBlock('unknown', log)).toBeUndefined()
  })

  test('says nothing when the output does not explain itself', () => {
    expect(extractFailureBlock('unknown', 'compiling\nlinking\n')).toBeUndefined()
  })
})

describe('isUpToDate', () => {
  test('gradle: up-to-date tasks with none executed', () => {
    expect(isUpToDate('gradle', 'BUILD SUCCESSFUL\n3 actionable tasks: 3 up-to-date', 0)).toBe(true)
    expect(
      isUpToDate('gradle', 'BUILD SUCCESSFUL\n3 actionable tasks: 2 executed, 1 up-to-date', 0),
    ).toBe(false)
  })

  test('cargo: finished without compiling anything', () => {
    expect(isUpToDate('cargo', '    Finished dev [unoptimized] target(s) in 0.04s', 0)).toBe(true)
    expect(
      isUpToDate('cargo', '   Compiling app v0.1.0\n    Finished dev target(s) in 3.1s', 0),
    ).toBe(false)
  })

  test('make and ninja announce it in words', () => {
    expect(isUpToDate('make', "make: Nothing to be done for 'all'.", 0)).toBe(true)
    expect(isUpToDate('ninja', 'ninja: no work to do.', 0)).toBe(true)
  })

  test('mix: silence is the evidence, compiling is the counter-evidence', () => {
    expect(isUpToDate('mix', '', 0)).toBe(true)
    expect(isUpToDate('mix', 'Compiling 3 files (.ex)\nGenerated app app', 0)).toBe(false)
  })

  test('never claims it for a system that gives no evidence either way', () => {
    expect(isUpToDate('go', '', 0)).toBe(false)
    expect(isUpToDate('dotnet', 'Build succeeded.', 0)).toBe(false)
  })

  test('never claims it for a failing build', () => {
    expect(isUpToDate('gradle', '3 actionable tasks: 3 up-to-date', 1)).toBe(false)
  })
})
