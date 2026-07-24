import { existsSync, readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import { logError } from '../../utils/log.js'
import type { Framework } from './types.js'

/**
 * Framework detection. Two entry points:
 *   - `detectFrameworkFromCommand` maps an explicit command to a Framework
 *     (mirrors the command matchers in src/outputFilter/Bash/filters/).
 *   - `detectTestRunner` inspects project files in `cwd` to synthesize a bare
 *     runner command when the model didn't pass one.
 *
 * All filesystem access is best-effort and swallow-then-log: detection must
 * never block a run.
 */

export type DetectedRunner = {
  framework: Framework
  command: string
}

// Command → framework. Ordered: more specific runners first.
// Note: catch2 and doctest are intentionally absent — they are C/C++ test
// *libraries* linked into an arbitrarily-named binary, so there is no command
// token to match. They are reachable only via an explicit `framework` override
// (the binary path passed as `command`), and are still wired through
// reporters/applyFilters/NO_PATH_POSITIONAL for that path.
const COMMAND_MATCHERS: Array<[RegExp, Framework]> = [
  [/\bvitest\b/, 'vitest'],
  [/\bjest\b/, 'jest'],
  [/\bmocha\b/, 'mocha'],
  [/\bplaywright\s+test\b/, 'playwright'],
  [/\bnode\b.*--test\b/, 'node-test'],
  [/\bdeno\s+test\b/, 'deno'],
  [/\b(?:dart|flutter)\s+test\b/, 'dart'],
  [/\bbun\s+test\b/, 'bun'],
  [/\b(?:py\.?test|python\s+-m\s+pytest)\b/, 'pytest'],
  [/\bgo\s+test\b/, 'go'],
  [/\bcargo\s+nextest\b/, 'nextest'],
  [/\bcargo\s+test\b/, 'cargo'],
  [/\b(?:bundle\s+exec\s+)?rspec\b/, 'rspec'],
  [/(?:^|[;&|]\s*|\bnpx\s+|\/)pest\b/, 'pest'],
  [/\b(?:phpunit|vendor\/bin\/phpunit)\b/, 'phpunit'],
  [/\bdotnet\s+test\b/, 'dotnet'],
  [/\bmvn\b/, 'maven'],
  [/\bgradle\b|\.\/gradlew\b/, 'gradle'],
  [/\bctest\b/, 'ctest'],
  [/\bmix\s+test\b/, 'elixir'],
  [/\b(?:rake|rails)\s+test\b/, 'minitest'],
]

export function detectFrameworkFromCommand(command: string): Framework {
  for (const [re, fw] of COMMAND_MATCHERS) {
    if (re.test(command)) return fw
  }
  return 'unknown'
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (e) {
    logError(`RunTests: failed to read ${file} — ${String(e)}`)
    return null
  }
}

function detectPackageManager(cwd: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(path.join(cwd, 'bun.lock')) || existsSync(path.join(cwd, 'bun.lockb'))) return 'bun'
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function detectNode(cwd: string): DetectedRunner | null {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'))
  if (!pkg) return null
  const deps = {
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
    ...((pkg.dependencies as Record<string, string>) ?? {}),
  }
  const pm = detectPackageManager(cwd)
  const runner = (bin: string) => (pm === 'bun' ? `bunx ${bin}` : pm === 'npm' ? `npx ${bin}` : `${pm} ${bin}`)

  if (deps.vitest) return { framework: 'vitest', command: `${runner('vitest')} run` }
  if (deps.jest) return { framework: 'jest', command: runner('jest') }
  if (deps.mocha) return { framework: 'mocha', command: runner('mocha') }
  if (deps['@playwright/test']) return { framework: 'playwright', command: `${runner('playwright')} test` }

  const scripts = (pkg.scripts as Record<string, string>) ?? {}
  if (pm === 'bun' && !scripts.test) return { framework: 'bun', command: 'bun test' }
  if (scripts.test) {
    // Wrapped script — can't inject a reporter reliably, falls back to text.
    const fw = detectFrameworkFromCommand(scripts.test)
    return { framework: fw, command: `${pm} test` }
  }
  return null
}

/** Shallow check: does any top-level file in `cwd` end with one of `exts`? */
function hasTopLevelFileWithExt(cwd: string, exts: string[]): boolean {
  try {
    return readdirSync(cwd).some(name => exts.some(ext => name.endsWith(ext)))
  } catch {
    return false
  }
}

/**
 * Inspect the project tree (cwd-scoped, not recursive into subprojects) and
 * synthesize a bare runner command. Returns null when nothing recognizable is
 * found — the caller then reports that it couldn't detect a suite.
 */
export function detectTestRunner(cwd: string): DetectedRunner | null {
  // JS/TS first — most common, and package.json is cheap + decisive.
  const node = detectNode(cwd)
  if (node) return node

  if (existsSync(path.join(cwd, 'deno.json')) || existsSync(path.join(cwd, 'deno.jsonc'))) {
    return { framework: 'deno', command: 'deno test' }
  }
  if (existsSync(path.join(cwd, 'pubspec.yaml'))) {
    const pub = safeRead(path.join(cwd, 'pubspec.yaml'))
    const isFlutter = /^flutter\s*:/m.test(pub) || /sdk:\s*flutter/.test(pub)
    return isFlutter
      ? { framework: 'dart', command: 'flutter test' }
      : { framework: 'dart', command: 'dart test' }
  }

  if (
    existsSync(path.join(cwd, 'pyproject.toml')) ||
    existsSync(path.join(cwd, 'pytest.ini')) ||
    existsSync(path.join(cwd, 'setup.cfg')) ||
    existsSync(path.join(cwd, 'tox.ini'))
  ) {
    return { framework: 'pytest', command: 'pytest' }
  }
  if (existsSync(path.join(cwd, 'go.mod'))) {
    return { framework: 'go', command: 'go test ./...' }
  }
  if (existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { framework: 'cargo', command: 'cargo test' }
  }
  if (existsSync(path.join(cwd, 'Gemfile')) && existsSync(path.join(cwd, 'spec'))) {
    return { framework: 'rspec', command: 'bundle exec rspec' }
  }
  if (existsSync(path.join(cwd, 'Rakefile')) && existsSync(path.join(cwd, 'test'))) {
    return { framework: 'minitest', command: 'rake test' }
  }
  if (existsSync(path.join(cwd, 'mix.exs'))) {
    return { framework: 'elixir', command: 'mix test' }
  }
  if (existsSync(path.join(cwd, 'pom.xml'))) {
    return { framework: 'maven', command: 'mvn test' }
  }
  if (existsSync(path.join(cwd, 'build.gradle')) || existsSync(path.join(cwd, 'build.gradle.kts'))) {
    const wrapper = existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
    return { framework: 'gradle', command: `${wrapper} test` }
  }
  if (hasTopLevelFileWithExt(cwd, ['.csproj', '.sln', '.fsproj'])) {
    return { framework: 'dotnet', command: 'dotnet test' }
  }
  if (
    existsSync(path.join(cwd, 'tests/Pest.php')) ||
    existsSync(path.join(cwd, 'vendor/bin/pest'))
  ) {
    return { framework: 'pest', command: 'vendor/bin/pest' }
  }
  if (existsSync(path.join(cwd, 'composer.json')) && existsSync(path.join(cwd, 'vendor/bin/phpunit'))) {
    return { framework: 'phpunit', command: 'vendor/bin/phpunit' }
  }
  if (existsSync(path.join(cwd, 'CMakeLists.txt'))) {
    const command = existsSync(path.join(cwd, 'build/CTestTestfile.cmake'))
      ? 'ctest --test-dir build'
      : 'ctest'
    return { framework: 'ctest', command }
  }
  return null
}
