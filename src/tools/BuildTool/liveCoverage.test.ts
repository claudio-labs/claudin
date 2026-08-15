/**
 * Live coverage for the Build tool: real toolchains, real failures.
 *
 * The committed suite proves the pipeline against RECORDED output. That leaves
 * one thing unproven — whether the recording still matches what the tool prints
 * today, on this machine, at this version. These tests close that gap by
 * compiling genuinely broken source and reading the result back.
 *
 * They are opt-in because they need toolchains no CI runner here has:
 *
 *   CLAUDIN_LIVE_BUILD=1 bun test src/tools/BuildTool/liveCoverage.test.ts
 *
 * Each case additionally skips itself when its compiler is absent, so a partial
 * toolchain reports what it could verify instead of failing.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatBuildResult } from 'src/tools/BuildTool/budget.js'
import { applyQuietFlags, detectAllBuildSystems, detectBuild } from 'src/tools/BuildTool/detect.js'
import { runBuild } from 'src/tools/BuildTool/run.js'
import type { BuildResult } from 'src/tools/BuildTool/types.js'

const LIVE = process.env.CLAUDIN_LIVE_BUILD === '1'
const roots: string[] = []

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-build-live-'))
  roots.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Detect and run exactly as `BuildTool.call` would, minus the permission hop. */
async function build(root: string): Promise<BuildResult> {
  const detected = detectBuild(root)
  if (!detected) throw new Error(`nothing detected in ${root}`)
  return runBuild({
    command: applyQuietFlags(detected.system, detected.command),
    system: detected.system,
    cwd: root,
    abortSignal: new AbortController().signal,
    timeoutMs: 300_000,
    idleTimeoutMs: 120_000,
    severity: 'errors',
    alsoDetected: detectAllBuildSystems(root),
  })
}

/**
 * What the raw command would have put in the transcript. Measured by running it
 * again rather than by reusing the tool's own capture, so the comparison is
 * against what a Bash call actually returns — including the human-format output
 * a machine-format flag would have replaced.
 */
function rawChars(root: string, command: string): number {
  const run = Bun.spawnSync(['sh', '-c', command], { cwd: root })
  return run.stdout.toString().length + run.stderr.toString().length
}

/** What the tool sends the model, against what the raw log would have cost. */
function report(label: string, root: string, result: BuildResult): void {
  const rendered = formatBuildResult(result)
  const raw = rawChars(root, result.command)
  const delta = raw > 0 ? Math.round((rendered.length / raw - 1) * 100) : 0
  console.log(
    `\n=== ${label} — ${result.system} · exit ${result.exitCode} · ` +
      `${rendered.length} chars vs ${raw} raw (${delta > 0 ? '+' : ''}${delta}%) ===\n${rendered}`,
  )
}

const describeLive = LIVE ? describe : describe.skip

describeLive('live · cargo', () => {
  const available = Boolean(Bun.which('cargo'))
  const manifest = '[package]\nname = "fix"\nversion = "0.1.0"\nedition = "2021"\n'

  test.skipIf(!available)('a type error comes back positioned and coded', async () => {
    const root = project({
      'Cargo.toml': manifest,
      'src/platform/main.rs': 'fn main() {\n    let x: i32 = "not a number";\n    println!("{x}");\n}\n',
    })
    const result = await build(root)
    report('cargo failure', root, result)

    expect(result.exitCode).not.toBe(0)
    expect(result.errors).toBeGreaterThan(0)
    expect(result.diagnostics[0]?.file).toEndWith('src/platform/main.rs')
    expect(result.diagnostics[0]?.line).toBe(2)
    expect(result.diagnostics[0]?.code).toBe('E0308')
    expect(result.degraded).toBe(false)
  }, 300_000)

  test.skipIf(!available)('a clean build names its binary, and a rerun rebuilds nothing', async () => {
    const root = project({
      'Cargo.toml': manifest,
      'src/platform/main.rs': 'fn main() {\n    println!("ok");\n}\n',
    })

    const first = await build(root)
    report('cargo success', root, first)
    expect(first.exitCode).toBe(0)
    expect(first.upToDate).toBe(false)
    expect(first.artifacts.some(a => a.endsWith('/fix'))).toBe(true)

    const second = await build(root)
    report('cargo rerun', root, second)
    expect(second.upToDate).toBe(true)
    expect(formatBuildResult(second)).toContain('up to date, nothing rebuilt')
  }, 300_000)
})

/**
 * The case the budget exists for. A one-error toy build is where this tool is
 * WORST — the source excerpt costs more than the log it replaces — so measuring
 * only those would flatter nothing and mislead about the rest.
 */
describeLive('live · a build with many errors', () => {
  const manifest = '[package]\nname = "fix"\nversion = "0.1.0"\nedition = "2021"\n'

  test.skipIf(!Bun.which('cargo'))('one repeated error is one entry, not forty', async () => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `    let v${i}: i32 = "still not a number";`,
    ).join('\n')
    const root = project({ 'Cargo.toml': manifest, 'src/platform/main.rs': `fn main() {\n${body}\n}\n` })
    const result = await build(root)
    report('cargo · 40 repeats', root, result)

    expect(result.errors).toBeGreaterThanOrEqual(40)
    const rendered = formatBuildResult(result)
    // One excerpt, then the other 39 sites as bare positions.
    expect(rendered).toContain('same diagnostic at')
    expect(rendered).toContain('36 more')
    expect(rendered.length).toBeLessThan(1_000)
  }, 300_000)

  test.skipIf(!Bun.which('cargo'))('distinct errors are capped and the rest counted', async () => {
    const body = Array.from({ length: 15 }, (_, i) => `    missing_fn_${i}();`).join('\n')
    const root = project({ 'Cargo.toml': manifest, 'src/platform/main.rs': `fn main() {\n${body}\n}\n` })
    const result = await build(root)
    report('cargo · 15 distinct', root, result)

    expect(result.errors).toBeGreaterThanOrEqual(15)
    const rendered = formatBuildResult(result)
    expect(rendered).toContain('more distinct diagnostics')
    // The whole point: the report does not grow with the error count.
    expect(rendered.length).toBeLessThan(3_000)
  }, 300_000)
})

describeLive('live · go', () => {
  const available = Boolean(Bun.which('go'))

  test.skipIf(!available)('a type error comes back positioned', async () => {
    const root = project({
      'go.mod': 'module fix\n\ngo 1.21\n',
      'main.go': 'package main\n\nfunc main() {\n\tvar x int = "not a number"\n\t_ = x\n}\n',
    })
    const result = await build(root)
    report('go failure', root, result)

    expect(result.system).toBe('go')
    expect(result.exitCode).not.toBe(0)
    expect(result.errors).toBeGreaterThan(0)
    expect(result.diagnostics[0]?.file).toContain('main.go')
    expect(result.diagnostics[0]?.line).toBe(4)
    expect(result.degraded).toBe(false)
  }, 300_000)

  test.skipIf(!available)('a clean build claims nothing about being up to date', async () => {
    // `go build` prints the same nothing either way, so the honest report omits
    // the line rather than guessing — this is that decision, live.
    const root = project({
      'go.mod': 'module fix\n\ngo 1.21\n',
      'main.go': 'package main\n\nfunc main() {\n\tprintln("ok")\n}\n',
    })
    const result = await build(root)
    report('go success', root, result)

    expect(result.exitCode).toBe(0)
    expect(result.upToDate).toBe(false)
    expect(formatBuildResult(result)).not.toContain('up to date')
  }, 300_000)
})

describeLive('live · make + cc', () => {
  const available = Boolean(Bun.which('make') && Bun.which('cc'))
  const makefile = 'all: app\n\napp: main.c\n\tcc -o app main.c\n'

  test.skipIf(!available)('a C error is positioned and the make failure is quoted', async () => {
    const root = project({
      Makefile: makefile,
      'main.c': '#include <stdio.h>\n\nint main(void) {\n  return undefined_symbol();\n}\n',
    })
    const result = await build(root)
    report('make failure', root, result)

    expect(result.system).toBe('make')
    expect(result.exitCode).not.toBe(0)
    expect(result.diagnostics[0]?.file).toContain('main.c')
    expect(result.diagnostics[0]?.line).toBe(4)
    // The `make: *** [Makefile:4: app] Error 1` line is what tells you WHICH
    // recipe died, and no diagnostic parser carries it.
    expect(result.failureBlock).toContain('Error 1')
  }, 300_000)

  test.skipIf(!available)('a rerun with nothing to do is reported as up to date', async () => {
    const root = project({
      Makefile: makefile,
      'main.c': '#include <stdio.h>\n\nint main(void) {\n  printf("ok\\n");\n  return 0;\n}\n',
    })

    const first = await build(root)
    report('make success', root, first)
    expect(first.exitCode).toBe(0)
    expect(first.upToDate).toBe(false)

    const second = await build(root)
    report('make rerun', root, second)
    expect(second.upToDate).toBe(true)
  }, 300_000)
})
