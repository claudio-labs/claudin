import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { formatBuildResult } from './budget.js'
import { BuildTool, resolveBuildCommand } from './BuildTool.js'
import type { BuildProgress, BuildResult } from './types.js'

const roots: string[] = []

function project(files: Record<string, string> = {}, executables: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-build-tool-'))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  for (const rel of executables) chmodSync(join(root, rel), 0o755)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const context = { abortController: new AbortController() } as Parameters<typeof BuildTool.call>[1]

async function callIn(root: string, input: Parameters<typeof BuildTool.call>[0]) {
  return runWithCwdOverride(root, async () => {
    const { data } = await BuildTool.call(input, context, undefined as never, undefined as never)
    return data as BuildResult
  })
}

describe('resolveBuildCommand', () => {
  test('an explicit command is honoured verbatim, plus the quiet flag', () => {
    const resolved = runWithCwdOverride(project(), () =>
      resolveBuildCommand({ command: 'cargo build' }),
    )
    expect(resolved).toEqual({ command: 'cargo build --message-format=json', system: 'cargo' })
  })

  test('a project with nothing to build resolves to nothing', () => {
    expect(runWithCwdOverride(project(), () => resolveBuildCommand({}))).toBeNull()
  })

  test('an override for a system this project does not have resolves to nothing', () => {
    const root = project({ 'Cargo.toml': '[package]' })
    expect(runWithCwdOverride(root, () => resolveBuildCommand({ system: 'gradle' }))).toBeNull()
  })
})

describe('BuildTool.call — nothing to run', () => {
  test('reports an actionable error instead of an empty green result', async () => {
    // The failure mode to avoid: "built" for a project that was never built at
    // all reads exactly like a successful build.
    const result = await callIn(project(), {})
    expect(result.runError).toContain('Could not detect a build system')
    expect(formatBuildResult(result)).toStartWith('Build could not run')
  })

  test('an unavailable override names that system, not detection in general', async () => {
    const result = await callIn(project({ 'Cargo.toml': '[package]' }), { system: 'gradle' })
    expect(result.runError).toContain('no gradle setup')
  })
})

/**
 * End to end against a fake `gradlew`. The wrapper is what detection picks, so
 * a script by that name exercises the whole path — detect, flag injection,
 * exec, parse, group, format — without needing a JVM or a real project.
 */
describe('BuildTool.call — fake gradle wrapper', () => {
  function gradleProject(script: string): string {
    return project({ 'build.gradle.kts': '', gradlew: `#!/bin/sh\n${script}\n` }, ['gradlew'])
  }

  test('reports the kotlin diagnostics of a failing build', async () => {
    const root = gradleProject(
      [
        'echo "> Task :app:compileKotlin FAILED"',
        'echo "e: file:///p/Foo.kt:10:20 Unresolved reference: bar"',
        'echo "FAILURE: Build failed with an exception."',
        'echo "* What went wrong:"',
        'echo "Execution failed for task \':app:compileKotlin\'."',
        'exit 1',
      ].join('\n'),
    )
    const result = await callIn(root, {})

    expect(result.system).toBe('gradle')
    expect(result.command).toBe('./gradlew assemble --console=plain')
    expect(result.exitCode).toBe(1)
    expect(result.errors).toBe(1)
    expect(result.diagnostics[0]).toMatchObject({
      file: '/p/Foo.kt',
      line: 10,
      message: 'Unresolved reference: bar',
    })
    expect(result.failureBlock).toContain("Execution failed for task ':app:compileKotlin'.")

    const rendered = formatBuildResult(result)
    expect(rendered).toStartWith('✗ gradle · build failed')
    expect(rendered).toContain('/p/Foo.kt:10:20')
  }, 30_000)

  test('a cached build is reported as up to date, never as clean', async () => {
    const root = gradleProject(
      ['echo "BUILD SUCCESSFUL in 412ms"', 'echo "3 actionable tasks: 3 up-to-date"'].join('\n'),
    )
    const result = await callIn(root, {})

    expect(result.upToDate).toBe(true)
    expect(formatBuildResult(result)).toContain('up to date, nothing rebuilt')
  }, 30_000)

  test('a build that goes silent is stopped and the report says what it was doing', async () => {
    const root = gradleProject(['echo "> Task :app:compileKotlin"', 'sleep 60'].join('\n'))
    const result = await callIn(root, { idleTimeout: 1_000 })

    expect(result.stall?.reason).toBe('idle')
    expect(result.stall?.lastLine).toBe('> Task :app:compileKotlin')

    const rendered = formatBuildResult(result)
    expect(rendered).toContain('no output for')
    // Stated as an observation, never as a diagnosis of a hang.
    expect(rendered).toContain('That is silence, not proof of a hang')
    expect(rendered).toContain('Raise idleTimeout')
  }, 30_000)

  test('a running build reports what it is doing', async () => {
    const root = gradleProject(
      [
        'echo "> Task :app:processResources"',
        'sleep 1',
        'echo "> Task :app:compileKotlin"',
        'sleep 1',
      ].join('\n'),
    )
    const seen: BuildProgress[] = []
    await runWithCwdOverride(root, () =>
      BuildTool.call({}, context, undefined as never, undefined as never, p => seen.push(p.data)),
    )

    // The two `sleep 1`s outlast the ~1s poll interval, so at least one tick
    // lands. How MANY land is a race against the scheduler — asserting a count
    // here is what made this flaky on a slower CI runner (it saw exactly one),
    // and it would have measured the poller's cadence rather than this wiring.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every(p => p.system === 'gradle')).toBe(true)
    // What this test alone can prove: the label reaching the UI is the phase
    // the extractor pulled out, not a raw tail. Which line it caught depends on
    // when the tick fired; that the newest one wins is pinned deterministically
    // in progressLine.test.ts.
    const tasks = ['> Task :app:processResources', '> Task :app:compileKotlin']
    expect(seen.every(p => p.label === '' || tasks.includes(p.label))).toBe(true)
  }, 30_000)
})

/**
 * No fake runner at all: a real `bun build` over a genuinely broken file, which
 * is the lane this repo itself lands in.
 */
describe('BuildTool.call — a project that is not the cwd', () => {
  test('builds the directory it is given, and detects there', async () => {
    const root = project({
      'README.md': '# workspace',
      'web/package.json': JSON.stringify({ scripts: { build: 'bun build ./ok.ts --outdir=out' } }),
      'web/bun.lock': '',
      'web/ok.ts': 'export const x = 1\n',
    })
    const result = await callIn(root, { directory: 'web' })

    expect(result.system).toBe('node')
    expect(result.command).toBe('bun run build')
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(root, 'web', 'out', 'ok.js'))).toBe(true)
  }, 30_000)

  test('a workspace root with nothing to build names the packages that have one', async () => {
    const root = project({
      'README.md': '# workspace',
      'web/package.json': JSON.stringify({ scripts: { build: 'tsup' } }),
      'core/Cargo.toml': '[package]',
      'node_modules/dep/Cargo.toml': '[package]',
      'docs/index.md': '# docs',
    })
    const result = await callIn(root, {})

    expect(result.runError).toContain('core, web')
    // Never suggests a directory the build itself wrote.
    expect(result.runError).not.toContain('node_modules')
    expect(result.runError).not.toContain('docs')
  }, 30_000)

  test('a directory that does not exist says so instead of building the cwd', async () => {
    const root = project({ 'package.json': JSON.stringify({ scripts: { build: 'true' } }) })
    const result = await callIn(root, { directory: 'nope' })

    expect(result.runError).toContain('No such directory')
    expect(result.command).toBe('')
  }, 30_000)
})

describe('BuildTool.call — real bun build', () => {
  test('a failure comes back positioned, not as a log', async () => {
    const root = project({
      'package.json': JSON.stringify({ scripts: { build: 'bun build ./broken.ts --outdir=out' } }),
      'bun.lock': '',
      'broken.ts': 'export const x = = 1\n',
    })
    const result = await callIn(root, {})

    expect(result.system).toBe('node')
    expect(result.command).toBe('bun run build')
    expect(result.exitCode).not.toBe(0)
    expect(result.diagnostics[0]).toMatchObject({
      line: 1,
      column: 18,
      severity: 'error',
      message: 'Unexpected =',
    })
    expect(result.diagnostics[0]?.file).toEndWith('broken.ts')
    expect(formatBuildResult(result)).toContain('Unexpected =')
  }, 30_000)

  test('a working build reports success and produces the artifact it was asked for', async () => {
    const root = project({
      'package.json': JSON.stringify({ scripts: { build: 'bun build ./ok.ts --outdir=out' } }),
      'bun.lock': '',
      'ok.ts': 'export const x = 1\n',
    })
    const result = await callIn(root, {})

    expect(result.exitCode).toBe(0)
    expect(result.errors).toBe(0)
    expect(existsSync(join(root, 'out', 'ok.js'))).toBe(true)
    expect(formatBuildResult(result)).toStartWith('✓ node · built')
  }, 30_000)
})
