import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  applyQuietFlags,
  detectAllBuildSystems,
  detectBuild,
  detectBuildFor,
  detectBuildSystemFromCommand,
} from 'src/tools/BuildTool/detect.js'
import { detectTestRunner } from 'src/tools/RunTestsTool/detect.js'
import { detectChecker } from 'src/tools/TypecheckTool/detect.js'
import type { BuildSystem } from 'src/tools/BuildTool/types.js'

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-detect-'))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return dir
}

describe('detectBuild', () => {
  test('runs the package.json build script with the lockfile-implied manager', () => {
    const dir = project({
      'package.json': JSON.stringify({ scripts: { build: 'tsup' } }),
      'pnpm-lock.yaml': '',
    })
    expect(detectBuild(dir)).toEqual({ system: 'node', command: 'pnpm run build' })
  })

  test('ignores a package.json with no build script', () => {
    const dir = project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })
    expect(detectBuild(dir)).toBeNull()
  })

  test('prefers the gradle wrapper and never picks a target that runs tests', () => {
    const dir = project({ 'build.gradle.kts': '', gradlew: '' })
    expect(detectBuild(dir)).toEqual({ system: 'gradle', command: './gradlew assemble' })
  })

  test('skips maven tests explicitly', () => {
    const dir = project({ 'pom.xml': '<project/>' })
    expect(detectBuild(dir)?.command).toBe('mvn package -DskipTests')
  })

  test('declines a Makefile with no all target', () => {
    const dir = project({ Makefile: 'install:\n\tcp a b\n' })
    expect(detectBuild(dir)).toBeNull()
  })

  test('accepts a Makefile that has one', () => {
    const dir = project({ Makefile: 'all: main.o\n\tcc -o app main.o\n' })
    expect(detectBuild(dir)).toEqual({ system: 'make', command: 'make all' })
  })

  test('declines cmake until the build tree is configured', () => {
    const unconfigured = project({ 'CMakeLists.txt': 'project(x)' })
    expect(detectBuild(unconfigured)).toBeNull()

    const configured = project({
      'CMakeLists.txt': 'project(x)',
      'build/CMakeCache.txt': '# cache',
    })
    expect(detectBuild(configured)).toEqual({ system: 'cmake', command: 'cmake --build build' })
  })

  test('declines a Rakefile whose default task is probably the suite', () => {
    const suite = project({ Rakefile: "task default: :test\ntask :test do\nend\n" })
    expect(detectBuild(suite)).toBeNull()

    const gem = project({ Rakefile: "require 'bundler/gem_tasks'\n" })
    expect(detectBuild(gem)).toEqual({ system: 'rake', command: 'rake build' })
  })

  test('builds a flutter app with the platform-independent target', () => {
    const dir = project({ 'pubspec.yaml': 'name: app\nflutter:\n  uses-material-design: true\n' })
    expect(detectBuild(dir)).toEqual({ system: 'flutter', command: 'flutter build bundle' })
  })

  test('declines a dart package with no entrypoint to compile', () => {
    const dir = project({ 'pubspec.yaml': 'name: lib\n' })
    expect(detectBuild(dir)).toBeNull()
  })

  test.each<[BuildSystem, Record<string, string>, string]>([
    ['sbt', { 'build.sbt': 'name := "x"' }, 'sbt compile'],
    ['mill', { 'build.sc': '' }, 'mill __.compile'],
    ['mill', { 'build.mill': '', mill: '' }, './mill __.compile'],
    ['mix', { 'mix.exs': 'defmodule X.MixProject do end' }, 'mix compile'],
    ['rebar3', { 'rebar.config': '{erl_opts, []}.' }, 'rebar3 compile'],
    ['swift', { 'Package.swift': '// swift-tools-version:5.9' }, 'swift build'],
    ['zig', { 'build.zig': 'pub fn build() void {}' }, 'zig build'],
    ['ninja', { 'build.ninja': 'rule cc' }, 'ninja'],
    ['dotnet', { 'app.csproj': '<Project/>' }, 'dotnet build'],
    ['dotnet', { 'app.fsproj': '<Project/>' }, 'dotnet build'],
    ['luarocks', { 'x-1.0-1.rockspec': 'package = "x"' }, 'luarocks make'],
    ['cabal', { 'x.cabal': 'name: x' }, 'cabal build'],
    ['cabal', { 'cabal.project': 'packages: .' }, 'cabal build'],
    ['stack', { 'stack.yaml': 'resolver: lts-22.0' }, 'stack build'],
    ['dart', { 'pubspec.yaml': 'name: cli\n', 'bin/main.dart': 'void main() {}' }, 'dart compile exe bin/main.dart'],
  ])('%s is detected from its marker file', (system, files, command) => {
    expect(detectBuild(project(files))).toEqual({ system, command })
  })

  test('an xcode project must be the bundle directory, not a file named like one', () => {
    const dir = project({ 'App.xcodeproj/project.pbxproj': '// pbx' })
    expect(detectBuild(dir)).toEqual({ system: 'xcodebuild', command: 'xcodebuild build' })

    const decoy = project({ 'notes-about.xcodeproj': 'this is a plain file' })
    expect(detectBuild(decoy)).toBeNull()
  })

  test('lists every configured system so the override is discoverable', () => {
    const dir = project({
      'Cargo.toml': '[package]',
      'go.mod': 'module x',
      'build.zig': '',
    })
    expect(detectAllBuildSystems(dir)).toEqual(['go', 'cargo', 'zig'])
  })

  test('an override resolves that system, not the first-detected one', () => {
    const dir = project({ 'Cargo.toml': '[package]', 'go.mod': 'module x' })
    expect(detectBuild(dir)?.system).toBe('go')
    expect(detectBuildFor(dir, 'cargo')).toEqual({ system: 'cargo', command: 'cargo build' })
    expect(detectBuildFor(dir, 'maven')).toBeNull()
  })
})

describe('probe order agrees with the other two detect-and-run tools', () => {
  // The comment above PROBES claims this; an agent that builds the JVM half of
  // a polyglot repo and type-checks the Node half is comparing two projects.
  test.each<
    [string, Record<string, string>, BuildSystem, NonNullable<ReturnType<typeof detectChecker>>['checker'], NonNullable<ReturnType<typeof detectTestRunner>>['framework']]
  >([
    [
      'node wins over go',
      {
        'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
        'tsconfig.json': '{}',
        'go.mod': 'module x',
      },
      'node',
      'tsc',
      'vitest',
    ],
    ['go wins over cargo', { 'go.mod': 'module x', 'Cargo.toml': '[package]' }, 'go', 'go', 'go'],
  ])('%s', (_label, files, system, checker, framework) => {
    const dir = project(files)
    expect(detectBuild(dir)?.system).toBe(system)
    expect(detectChecker(dir)?.checker).toBe(checker)
    expect(detectTestRunner(dir)?.framework).toBe(framework)
  })
})

describe('detectBuildSystemFromCommand', () => {
  test.each<[string, BuildSystem]>([
    ['cargo build --release', 'cargo'],
    ['./gradlew assemble', 'gradle'],
    ['./mvnw package', 'maven'],
    ['dotnet build', 'dotnet'],
    ['cmake --build build', 'cmake'],
    ['bun run build', 'node'],
    ['who knows', 'unknown'],
  ])('%s → %s', (command, expected) => {
    expect(detectBuildSystemFromCommand(command)).toBe(expected)
  })
})

describe('applyQuietFlags', () => {
  test('asks cargo for its machine format', () => {
    expect(applyQuietFlags('cargo', 'cargo build')).toBe('cargo build --message-format=json')
  })

  test('turns off the gradle progress bar, which rewrites its line', () => {
    expect(applyQuietFlags('gradle', './gradlew assemble')).toBe(
      './gradlew assemble --console=plain',
    )
  })

  test('never contradicts a flag the caller already passed', () => {
    expect(applyQuietFlags('cargo', 'cargo build --message-format=short')).toBe(
      'cargo build --message-format=short',
    )
    expect(applyQuietFlags('maven', 'mvn -B package')).toBe('mvn -B package')
  })

  test('crosses a package-manager boundary with the -- separator', () => {
    // Without it the manager eats the flag instead of forwarding it.
    expect(applyQuietFlags('cargo', 'npm run build')).toBe('npm run build -- --message-format=json')
  })

  test('leaves a system with no flag plan alone', () => {
    expect(applyQuietFlags('go', 'go build ./...')).toBe('go build ./...')
  })
})
