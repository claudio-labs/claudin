import { describe, expect, test } from 'bun:test'
import { lastNonEmptyLine } from './progressLine.js'
import { collectArtifacts, stripProgressRewrites } from './run.js'

describe('collectArtifacts', () => {
  test('reads the executable cargo says it linked', () => {
    const stream = [
      JSON.stringify({ reason: 'compiler-message', message: {} }),
      JSON.stringify({
        reason: 'compiler-artifact',
        target: { name: 'app' },
        executable: '/p/target/debug/app',
      }),
      '    Finished dev [unoptimized] target(s) in 3.1s',
    ].join('\n')
    expect(collectArtifacts('cargo', stream)).toEqual(['/p/target/debug/app'])
  })

  test('skips the library artifacts, which carry no executable', () => {
    const stream = JSON.stringify({
      reason: 'compiler-artifact',
      target: { name: 'lib' },
      executable: null,
    })
    expect(collectArtifacts('cargo', stream)).toEqual([])
  })

  test('reports each executable once however many times cargo names it', () => {
    const line = JSON.stringify({ reason: 'compiler-artifact', executable: '/p/target/debug/app' })
    expect(collectArtifacts('cargo', [line, line].join('\n'))).toEqual(['/p/target/debug/app'])
  })

  test('a truncated json line is not a build failure', () => {
    const stream = ['{"reason":"compiler-artifact","executable":"/p/a', ''].join('\n')
    expect(() => collectArtifacts('cargo', stream)).not.toThrow()
    expect(collectArtifacts('cargo', stream)).toEqual([])
  })

  test('trusts only cargo, not a JSON line that happens to look like one', () => {
    // Artifacts are never inferred — not from the filesystem, where a binary
    // left by an earlier run is indistinguishable from a fresh one, and not
    // from another toolchain's logs, which may carry JSON of their own.
    const gradleLog = [
      'BUILD SUCCESSFUL in 4s',
      JSON.stringify({ reason: 'compiler-artifact', executable: '/p/not-ours' }),
    ].join('\n')
    expect(collectArtifacts('gradle', gradleLog)).toEqual([])
    expect(collectArtifacts('cargo', gradleLog)).toEqual(['/p/not-ours'])
  })
})

describe('stripProgressRewrites', () => {
  test('keeps only what a terminal would have shown of a redrawn line', () => {
    const redrawn = ' Building [=>    ] 1/9\r Building [====> ] 5/9\r Building [======] 9/9'
    expect(stripProgressRewrites(`start\n${redrawn}\ndone`)).toBe(
      'start\n Building [======] 9/9\ndone',
    )
  })

  test('leaves output that never redrew exactly as it was', () => {
    const plain = 'a\nb\nc'
    expect(stripProgressRewrites(plain)).toBe(plain)
  })
})

describe('lastNonEmptyLine', () => {
  test('skips the trailing blank lines a killed process leaves behind', () => {
    expect(lastNonEmptyLine('> Task :app:compileKotlin\n\n   \n')).toBe('> Task :app:compileKotlin')
  })

  test('says nothing when there was no output at all', () => {
    expect(lastNonEmptyLine('\n\n')).toBeUndefined()
  })
})
