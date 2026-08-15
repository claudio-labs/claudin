import { beforeEach, describe, expect, test } from 'bun:test'
import {
  isRedirectableBuildCommand,
  parseRedirectableBuild,
  renderBuildRedirect,
  resetBuildRedirectMemoForTesting,
  shouldRedirectToBuild,
  stripOutputTrimTail,
} from 'src/tools/BuildTool/redirect.js'

beforeEach(() => {
  resetBuildRedirectMemoForTesting()
})

describe('parseRedirectableBuild — the monorepo `cd` prefix', () => {
  test.each([
    ['cd web && make all', 'web', 'make all'],
    ['cd ./packages/core && cargo build', './packages/core', 'cargo build'],
    ["cd 'my app' && ninja", 'my app', 'ninja'],
    ['cd "my app" && ninja', 'my app', 'ninja'],
    ['cd /abs/path && ./gradlew assemble', '/abs/path', './gradlew assemble'],
  ])('%s builds %s', (command, directory, inner) => {
    expect(parseRedirectableBuild(command)).toEqual({ command: inner, directory })
  })

  test('the trailing output filter is still stripped before the directory is read', () => {
    expect(parseRedirectableBuild('cd core && cargo build 2>&1 | head -20')).toEqual({
      command: 'cargo build',
      directory: 'core',
    })
  })

  test.each([
    // A second command after the build is a side effect Build would not run.
    'cd web && make all && ./deploy.sh',
    // Two cd's is not a shape we claim to understand.
    'cd a && cd b && make',
    // The rules still apply to what follows the cd.
    'cd web && make install',
    'cd web && npm run build',
    'cd web && make --dry-run',
    // A cd on its own is not a build.
    'cd web',
  ])('leaves %s in Bash', command => {
    expect(parseRedirectableBuild(command)).toBeNull()
  })

  test('a bare build reports no directory rather than the current one', () => {
    // `directory: "."` would be noise in the call the message asks for.
    expect(parseRedirectableBuild('cargo build')).toEqual({ command: 'cargo build' })
  })

  test('the refusal names both arguments and says the cd is unnecessary', () => {
    const message = renderBuildRedirect('cd core && cargo build')
    expect(message).toContain('directory: "core"')
    expect(message).toContain('command: "cargo build"')
    expect(message).toContain('you do not need the `cd`')
  })
})

describe('isRedirectableBuildCommand', () => {
  test.each([
    'cargo build',
    'cargo build --release',
    './gradlew assemble',
    'gradle build',
    './mvnw package',
    'mvn package -DskipTests',
    'dotnet build',
    'cmake --build build',
    'ninja',
    'make all',
    'sbt compile',
    'swift build',
    'xcodebuild',
  ])('redirects %s', command => {
    expect(isRedirectableBuildCommand(command)).toBe(true)
  })

  test.each(['npm run build', 'bun run build', 'pnpm build', 'yarn build'])(
    'leaves %s in Bash',
    command => {
      // Measured over 502 recorded sessions: a JS build's result is a median of
      // 286 characters, so a refusal round trip would cost more than it saves.
      expect(isRedirectableBuildCommand(command)).toBe(false)
    },
  )

  test.each([
    'cargo install ripgrep',
    'make install',
    'mvn deploy',
    './gradlew publish',
    'cargo clean',
    'make run',
  ])('never refuses %s, whose side effect is the point', command => {
    expect(isRedirectableBuildCommand(command)).toBe(false)
  })

  test.each([
    'make lint',
    'make fmt',
    'make test',
    'make docs',
    'make check',
    './gradlew lint',
    'mvn checkstyle:check',
  ])('never refuses %s, whose target is not a build', command => {
    // The make/gradle/mvn/sbt entries accept ANY target, so before the
    // non-build exclusion a linter's output went through the compiler
    // diagnostic parsers. `make test` lands here rather than in the RunTests
    // lane: that lane's head regex has no `make` token.
    expect(isRedirectableBuildCommand(command)).toBe(false)
  })

  test('a composed command stays in Bash — the tool cannot run the other half', () => {
    expect(isRedirectableBuildCommand('cargo build && ./target/debug/app')).toBe(false)
    expect(isRedirectableBuildCommand('cd sub; make all')).toBe(false)
  })

  test('the tool must be what the command starts with', () => {
    // Otherwise a search for the string gets refused by the build tool, which
    // is the worst possible false positive.
    expect(isRedirectableBuildCommand('rg "cargo build" src')).toBe(false)
  })

  test.each(['cargo build --verbose', './gradlew assemble --stacktrace', 'make all --dry-run'])(
    'respects the raw-output intent of %s',
    command => {
      expect(isRedirectableBuildCommand(command)).toBe(false)
    },
  )

  test('an output-trimming tail still redirects, and is stripped from the suggestion', () => {
    expect(isRedirectableBuildCommand('cargo build 2>&1 | tail -40')).toBe(true)
    expect(stripOutputTrimTail('cargo build 2>&1 | tail -40')).toBe('cargo build')
  })
})

describe('shouldRedirectToBuild', () => {
  test('refuses once, then runs the identical re-send', () => {
    expect(shouldRedirectToBuild('cargo build')).toBe(true)
    expect(shouldRedirectToBuild('cargo build')).toBe(false)
  })

  test('the escape belongs to that command alone', () => {
    expect(shouldRedirectToBuild('cargo build')).toBe(true)
    expect(shouldRedirectToBuild('make all')).toBe(true)
  })
})

describe('renderBuildRedirect', () => {
  test('names the tool, the exact command to pass, and the way out', () => {
    const message = renderBuildRedirect('cargo build --release')
    expect(message).toContain('Build')
    expect(message).toContain('"cargo build --release"')
    expect(message).toContain('re-send this exact Bash command')
  })

  test('explains the dropped filter only when there was one', () => {
    expect(renderBuildRedirect('cargo build | tail -20')).toContain('output filter is dropped')
    expect(renderBuildRedirect('cargo build')).not.toContain('output filter is dropped')
  })
})
