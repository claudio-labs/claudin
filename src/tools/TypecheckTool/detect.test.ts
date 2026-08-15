import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyCompactFlags,
  detectAllCheckers,
  detectChecker,
  detectCheckerFor,
  detectCheckerFromCommand,
} from 'src/tools/TypecheckTool/detect.js'
import type { Checker } from 'src/tools/TypecheckTool/types.js'

const roots: string[] = []

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'claudin-typecheck-detect-'))
  roots.push(root)
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, contents)
  }
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('detectCheckerFromCommand', () => {
  // Annotated: test.each widens a bare literal array to string[][], which does
  // not satisfy the Checker parameter of toBe.
  const cases: Array<[string, Checker]> = [
    ['tsc --noEmit', 'tsc'],
    ['bun run typecheck', 'tsc'],
    ['vue-tsc --noEmit', 'tsc'],
    ['cargo check', 'cargo'],
    ['deno check', 'deno'],
    ['go vet ./...', 'go'],
    ['dart analyze', 'dart'],
    ['flutter analyze', 'dart'],
    ['dotnet build', 'dotnet'],
    ['vendor/bin/phpstan analyse', 'phpstan'],
    ['git status', 'unknown'],
  ]
  test.each(cases)('%s → %s', (command, expected) => {
    expect(detectCheckerFromCommand(command)).toBe(expected)
  })

  test('a package script named typecheck maps to tsc despite carrying no token', () => {
    // Without this the compact-output flag is never injected into an explicitly
    // passed `bun run typecheck`, and it parses from pretty layout instead.
    expect(detectCheckerFromCommand('npm run type-check')).toBe('tsc')
    expect(detectCheckerFromCommand('pnpm check-types')).toBe('tsc')
  })
})

describe('detectChecker', () => {
  test("prefers the project's own typecheck script over the local binary", () => {
    // The script carries flags the project needs (`-p tsconfig.build.json`) and
    // keeps node_modules/.bin on PATH, which running its body would not.
    const root = project({
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc -p tsconfig.build.json' } }),
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'bun.lock': '',
    })
    expect(detectChecker(root)).toEqual({
      checker: 'tsc',
      command: 'bun run typecheck',
      composedScript: false,
      toolchainDir: 'node_modules/.bin',
    })
  })

  test('marks a composed script so the compact flag is not injected into it', () => {
    const root = project({
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit && eslint .' } }),
    })
    expect(detectChecker(root)?.composedScript).toBe(true)
  })

  test('falls back to the locally installed compiler with no script', () => {
    const root = project({ 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '#!/bin/sh\n' })
    expect(detectChecker(root)).toMatchObject({
      checker: 'tsc',
      command: './node_modules/.bin/tsc --noEmit',
    })
  })

  test('picks the package manager from the lockfile', () => {
    const root = project({
      'tsconfig.json': '{}',
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'pnpm-lock.yaml': '',
    })
    expect(detectChecker(root)?.command).toBe('pnpm run typecheck')
  })

  test('detects the non-JS ecosystems by marker file', () => {
    expect(detectChecker(project({ 'Cargo.toml': '' }))).toEqual({
      checker: 'cargo',
      command: 'cargo check',
    })
    expect(detectChecker(project({ 'go.mod': 'module m' }))).toEqual({
      checker: 'go',
      command: 'go build ./...',
    })
    expect(detectChecker(project({ 'pubspec.yaml': 'name: x\n' }))).toEqual({
      checker: 'dart',
      command: 'dart analyze',
    })
    expect(detectChecker(project({ 'pubspec.yaml': 'sdk: flutter\n' }))).toEqual({
      checker: 'dart',
      command: 'flutter analyze',
    })
    expect(detectChecker(project({ 'app.csproj': '' }))).toEqual({
      checker: 'dotnet',
      command: 'dotnet build',
    })
  })

  test('prefers a build wrapper when the project ships one', () => {
    // A wrapper-only project has no global `mvn`/`gradle` to call at all.
    expect(detectChecker(project({ 'pom.xml': '', mvnw: '' }))?.command).toBe('./mvnw compile')
    expect(detectChecker(project({ 'build.gradle': '', gradlew: '' }))?.command).toBe(
      './gradlew compileJava',
    )
  })

  test('returns null when nothing is detected', () => {
    expect(detectChecker(project({ 'README.md': '# hi' }))).toBeNull()
  })

  test('resolves a specific checker for the override, or nothing', () => {
    // Pairing an override with the FIRST detected command would run the wrong
    // program and parse its output with the wrong parser.
    const root = project({
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'Cargo.toml': '',
    })
    expect(detectCheckerFor(root, 'cargo')).toEqual({ checker: 'cargo', command: 'cargo check' })
    expect(detectCheckerFor(root, 'go')).toBeNull()
  })

  test('lists every detectable checker so the result can name the alternatives', () => {
    const root = project({
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'Cargo.toml': '',
      'go.mod': 'module m',
    })
    expect(detectAllCheckers(root)).toEqual(['tsc', 'go', 'cargo'])
  })
})

describe('applyCompactFlags', () => {
  test('appends the machine-readable flag per checker', () => {
    expect(applyCompactFlags('tsc', 'tsc --noEmit')).toBe('tsc --noEmit --pretty false')
    expect(applyCompactFlags('cargo', 'cargo check')).toBe('cargo check --message-format=json')
    expect(applyCompactFlags('pyright', 'pyright')).toBe('pyright --outputjson')
  })

  test('crosses a package script with the -- separator', () => {
    // Without it the flag is consumed as the package manager's own argument and
    // never reaches the checker.
    expect(applyCompactFlags('tsc', 'bun run typecheck')).toBe(
      'bun run typecheck -- --pretty false',
    )
  })

  test('never contradicts a flag the caller already chose', () => {
    expect(applyCompactFlags('tsc', 'tsc --pretty true')).toBe('tsc --pretty true')
    expect(applyCompactFlags('cargo', 'cargo check --message-format=short')).toBe(
      'cargo check --message-format=short',
    )
  })

  test('dotnet only skips the restore once one has actually happened', () => {
    // `--no-restore` against an unrestored project does not save time, it fails
    // with NETSDK1004 — and that failure looks exactly like a type error.
    const cold = project({ 'app.csproj': '<Project />' })
    expect(applyCompactFlags('dotnet', 'dotnet build', cold)).toBe('dotnet build -clp:NoSummary')

    const warm = project({ 'app.csproj': '<Project />', 'obj/project.assets.json': '{}' })
    expect(applyCompactFlags('dotnet', 'dotnet build', warm)).toBe(
      'dotnet build -clp:NoSummary --no-restore',
    )

    // The usual solution layout keeps each project one level down.
    const nested = project({ 'app/app.csproj': '<Project />', 'app/obj/project.assets.json': '{}' })
    expect(applyCompactFlags('dotnet', 'dotnet build', nested)).toContain('--no-restore')
  })

  test('maven is never forced offline', () => {
    // `-o` shapes no output and aborts the whole run against a cold ~/.m2
    // ("Cannot access central in offline mode"), so the check silently never
    // happens on a fresh clone or in CI.
    const command = applyCompactFlags('maven', 'mvn compile', project({ 'pom.xml': '<project/>' }))
    expect(command).toBe('mvn compile -q')
    expect(command).not.toContain('-o')
  })

  test('leaves checkers with no compact mode alone', () => {
    expect(applyCompactFlags('gradle', 'gradle compileJava')).toBe('gradle compileJava')
    expect(applyCompactFlags('deno', 'deno check')).toBe('deno check')
    expect(applyCompactFlags('go', 'go build ./...')).toBe('go build ./...')
  })
})
