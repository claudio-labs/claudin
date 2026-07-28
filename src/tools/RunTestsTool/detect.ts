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
  [/\bdeno\s+(?:task\s+)?test\b/, 'deno'],
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
  [/\bmvn\b|\.\/mvnw\b/, 'maven'],
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
    // `npm|pnpm|yarn test` run the script, but `bun test` does NOT: it is Bun's
    // own runner, and only `bun run test` executes the script. Emitting the
    // former for a project whose script is ava/uvu/`node --test` either finds
    // no test files or — worse — picks up `*.test.ts` and runs them under the
    // wrong runner, reporting failures that belong to nobody. When the script
    // IS Bun's runner, keep the direct form so a reporter can still be injected.
    const command = pm === 'bun' && fw !== 'bun' ? 'bun run test' : `${pm} test`
    return { framework: fw, command }
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
 * A composer `test` script is either a string or an array of steps; join the
 * array so the framework matchers can still see the runner token inside it.
 */
function composerTestScript(cwd: string): string | null {
  const composer = readJsonSafe(path.join(cwd, 'composer.json'))
  const test = (composer?.scripts as Record<string, unknown> | undefined)?.test
  if (typeof test === 'string') return test
  if (Array.isArray(test)) {
    const steps = test.filter((s): s is string => typeof s === 'string')
    return steps.length > 0 ? steps.join(' ') : null
  }
  return null
}

/**
 * Python projects almost never run their suite with a bare `pytest`: the deps
 * live in a manager-owned virtualenv, so a bare invocation resolves to whatever
 * interpreter happens to be on PATH — usually a global one that cannot import
 * the project at all. That run does NOT fail loudly. It collects zero tests and
 * reports the import errors as N failing "tests", which reads as a broken suite
 * and sends the caller back to Bash. So mirror what the project's own
 * Makefile/CI does and go through the manager (or the in-tree venv).
 */
const PYTHON_MANAGER_LOCKFILES: Array<[string, string]> = [
  ['uv.lock', 'uv run'],
  ['poetry.lock', 'poetry run'],
  ['pdm.lock', 'pdm run'],
  ['Pipfile.lock', 'pipenv run'],
  ['Pipfile', 'pipenv run'],
]

/** In-tree venv interpreters, used when no manager lockfile identifies one. */
const VENV_PYTEST_BINS = ['.venv/bin/pytest', 'venv/bin/pytest']

function detectPytestCommand(cwd: string): string {
  for (const [lockfile, prefix] of PYTHON_MANAGER_LOCKFILES) {
    if (existsSync(path.join(cwd, lockfile))) return `${prefix} pytest`
  }
  for (const bin of VENV_PYTEST_BINS) {
    if (existsSync(path.join(cwd, bin))) return bin
  }
  return 'pytest'
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

  const denoConfig = [path.join(cwd, 'deno.json'), path.join(cwd, 'deno.jsonc')].find(f =>
    existsSync(f),
  )
  if (denoConfig) {
    // Deno tests are sandboxed: a bare `deno test` holds no fs/net permission,
    // so every test that touches either fails with PermissionDenied — a failure
    // that reads as real and isn't. The project's own `test` task carries the
    // flags its suite needs (`-A`, `--unstable-*`), and `deno task` forwards our
    // injected reporter flag through to the runner, so nothing is lost by
    // preferring it.
    const tasks = readJsonSafe(denoConfig)?.tasks as Record<string, unknown> | undefined
    return {
      framework: 'deno',
      command: tasks?.test != null ? 'deno task test' : 'deno test',
    }
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
    return { framework: 'pytest', command: detectPytestCommand(cwd) }
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
    // Same reason the rspec branch above shells through bundler: without it the
    // gems resolve against the system installation and the suite dies with a
    // LoadError before running a single test.
    const bundled = existsSync(path.join(cwd, 'Gemfile')) ? 'bundle exec ' : ''
    return { framework: 'minitest', command: `${bundled}rake test` }
  }
  if (existsSync(path.join(cwd, 'mix.exs'))) {
    return { framework: 'elixir', command: 'mix test' }
  }
  if (existsSync(path.join(cwd, 'pom.xml'))) {
    // Mirrors the gradle branch below: the wrapper pins the build tool's
    // version and is frequently the ONLY one present — such a project has no
    // global `mvn` to call at all.
    const wrapper = existsSync(path.join(cwd, 'mvnw')) ? './mvnw' : 'mvn'
    return { framework: 'maven', command: `${wrapper} test` }
  }
  if (existsSync(path.join(cwd, 'build.gradle')) || existsSync(path.join(cwd, 'build.gradle.kts'))) {
    const wrapper = existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
    return { framework: 'gradle', command: `${wrapper} test` }
  }
  if (hasTopLevelFileWithExt(cwd, ['.csproj', '.sln', '.fsproj'])) {
    return { framework: 'dotnet', command: 'dotnet test' }
  }
  if (existsSync(path.join(cwd, 'vendor/bin/pest'))) {
    return { framework: 'pest', command: 'vendor/bin/pest' }
  }
  if (existsSync(path.join(cwd, 'composer.json')) && existsSync(path.join(cwd, 'vendor/bin/phpunit'))) {
    return { framework: 'phpunit', command: 'vendor/bin/phpunit' }
  }
  // Neither binary sits at the default path — either vendor/ is not installed
  // yet or composer's bin-dir is configured elsewhere. The declared script is
  // the project's own entry point and knows where its runner lives; naming a
  // `vendor/bin/*` that does not exist would only report a missing file.
  const composerTest = composerTestScript(cwd)
  if (composerTest) {
    const fw = detectFrameworkFromCommand(composerTest)
    return { framework: fw === 'unknown' ? 'phpunit' : fw, command: 'composer test' }
  }
  if (existsSync(path.join(cwd, 'tests/Pest.php'))) {
    return { framework: 'pest', command: 'vendor/bin/pest' }
  }
  if (existsSync(path.join(cwd, 'CMakeLists.txt'))) {
    const command = existsSync(path.join(cwd, 'build/CTestTestfile.cmake'))
      ? 'ctest --test-dir build'
      : 'ctest'
    return { framework: 'ctest', command }
  }
  return null
}
