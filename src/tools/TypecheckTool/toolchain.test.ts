import { describe, expect, test } from 'bun:test'
import { detectChecker } from 'src/tools/TypecheckTool/detect.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

/**
 * What these pin, found live rather than in a test: baseline reconstruction
 * checks out HEAD into a worktree that carries tracked sources and nothing
 * else, so a project-local `./node_modules/.bin/tsc` exited 127. A 127 parses
 * as no diagnostics, which reads as "HEAD was clean" — and a clean HEAD is an
 * ACCEPTED baseline, so the entire backlog would have come back reported as
 * newly introduced.
 *
 * The runner cannot recognise those paths on its own without also matching
 * `./gradlew`, so detection has to name the directory. These tests cover the
 * naming; `execChecker` consumes it.
 */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-toolchain-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

describe('toolchainDir', () => {
  test('names the JS bin directory for a project-local compiler', () => {
    const root = project({ 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '#!/bin/sh\n' })
    expect(detectChecker(root)?.toolchainDir).toBe('node_modules/.bin')
  })

  test('names it for a package script too, which has no path in the command', () => {
    // `bun run typecheck` resolves its binary through the package manager's
    // PATH, which points at wherever the run happens — the checkout, where
    // there is nothing.
    const root = project({
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'bun.lock': '',
    })
    expect(detectChecker(root)).toMatchObject({
      command: 'bun run typecheck',
      toolchainDir: 'node_modules/.bin',
    })
  })

  test('names the virtualenv for Python, the case the old pattern missed', () => {
    const root = project({ 'mypy.ini': '[mypy]\n', '.venv/bin/mypy': '#!/bin/sh\n' })
    expect(detectChecker(root)).toMatchObject({
      command: './.venv/bin/mypy .',
      toolchainDir: '.venv/bin',
    })
  })

  test('names the unprefixed venv variant as well', () => {
    const root = project({ 'mypy.ini': '[mypy]\n', 'venv/bin/mypy': '#!/bin/sh\n' })
    expect(detectChecker(root)?.toolchainDir).toBe('venv/bin')
  })

  test('names the Composer bin directory for PHP, which has no ./ prefix', () => {
    const root = project({ 'phpstan.neon': '', 'vendor/bin/phpstan': '#!/bin/sh\n' })
    expect(detectChecker(root)).toMatchObject({
      command: 'vendor/bin/phpstan analyse',
      toolchainDir: 'vendor/bin',
    })
  })

  test('stays unset for checkers that live on the global PATH', () => {
    const cases: Record<string, string>[] = [
      { 'Cargo.toml': '' },
      { 'go.mod': 'module m' },
      { 'app.csproj': '' },
      { 'pubspec.yaml': 'name: x\n' },
    ]
    for (const files of cases) {
      expect(detectChecker(project(files))?.toolchainDir).toBeUndefined()
    }
  })

  test('stays unset for a tracked build wrapper, which the checkout does have', () => {
    // ./gradlew and ./mvnw are committed files. Re-pointing them at the project
    // would run the wrong checkout's wrapper for no reason.
    expect(detectChecker(project({ 'pom.xml': '', mvnw: '' }))?.toolchainDir).toBeUndefined()
    expect(
      detectChecker(project({ 'build.gradle': '', gradlew: '' }))?.toolchainDir,
    ).toBeUndefined()
  })
})
