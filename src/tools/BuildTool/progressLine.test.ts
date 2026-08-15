import { describe, expect, test } from 'bun:test'
import { lastNonEmptyLine, progressLabel } from 'src/tools/BuildTool/progressLine.js'

describe('progressLabel', () => {
  test('ninja reports the ratio, which is the only form that says how far along it is', () => {
    const tail = [
      '[310/847] Building CXX object src/bar.cc.o',
      '[311/847] Building CXX object src/baz.cc.o',
      '[312/847] Building CXX object src/foo.cc.o',
    ].join('\n')
    expect(progressLabel('ninja', tail)).toBe('[312/847] Building CXX object src/foo.cc.o')
  })

  test('cargo human lines survive --message-format=json on the same stream', () => {
    // Captured live from `cargo build --message-format=json` with the tool's
    // own flags: the JSON goes to stdout, the progress to stderr, and the file
    // mode interleaves both.
    const tail = [
      '    Updating crates.io index',
      '     Locking 7 packages to latest compatible versions',
      '   Compiling serde_core v1.0.229',
      '{"reason":"compiler-artifact","target":{"name":"serde_core"}}',
      '   Compiling serde v1.0.229',
    ].join('\n')
    expect(progressLabel('cargo', tail)).toBe('Compiling serde v1.0.229')
  })

  test('a cargo tail that is only JSON falls back rather than showing a JSON line', () => {
    // The fallback is the last non-empty line, which here IS the JSON — better
    // than nothing, and the case only lasts one poll.
    const tail = '{"reason":"compiler-message","message":{"level":"error"}}'
    expect(progressLabel('cargo', tail)).toBe(tail)
  })

  test('gradle reports the running task', () => {
    const tail = ['> Task :app:processResources', '> Task :app:compileKotlin'].join('\n')
    expect(progressLabel('gradle', tail)).toBe('> Task :app:compileKotlin')
  })

  test('maven reports the module being built', () => {
    const tail = [
      '[INFO] ------------------------------------------------------------',
      '[INFO] Building my-service 2.1.0',
      '[INFO] ------------------------------------------------------------',
    ].join('\n')
    expect(progressLabel('maven', tail)).toBe('[INFO] Building my-service 2.1.0')
  })

  test('make has no phase of its own, so the echoed recipe is the label', () => {
    // Captured live: make just echoes each recipe line as it runs it.
    const tail = ['cc -c main.c -o main.o', 'cc -c util.c -o util.o'].join('\n')
    expect(progressLabel('make', tail)).toBe('cc -c util.c -o util.o')
  })

  test('a toolchain with no rule still gets its last line', () => {
    expect(progressLabel('go', 'some output\nlast line here\n')).toBe('last line here')
  })

  test('column padding is collapsed and a long line is cut', () => {
    expect(progressLabel('make', '   cc     -c    main.c   ')).toBe('cc -c main.c')
    const long = `cc ${'x'.repeat(200)}`
    const label = progressLabel('make', long)!
    expect(label.length).toBeLessThanOrEqual(90)
    expect(label.endsWith('…')).toBe(true)
  })

  test('an empty tail has nothing to say', () => {
    expect(progressLabel('cargo', '')).toBeNull()
    expect(progressLabel('cargo', '   \n\n')).toBeNull()
  })

  test('repeated calls do not skip matches through a shared lastIndex', () => {
    // The rules hold `g` regexes; reusing the literal across calls would carry
    // `lastIndex` over and make the second call miss.
    const tail = '[1/2] Building a\n[2/2] Building b'
    expect(progressLabel('ninja', tail)).toBe('[2/2] Building b')
    expect(progressLabel('ninja', tail)).toBe('[2/2] Building b')
  })
})

describe('lastNonEmptyLine', () => {
  test('skips trailing blank lines', () => {
    expect(lastNonEmptyLine('> Task :app:compileKotlin\n\n   \n')).toBe('> Task :app:compileKotlin')
  })

  test('has no answer for output that is entirely blank', () => {
    expect(lastNonEmptyLine('\n\n')).toBeUndefined()
  })
})
