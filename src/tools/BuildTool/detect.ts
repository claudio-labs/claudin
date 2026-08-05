import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import type { BuildSystem } from './types.js'

/**
 * Which build system this project uses, what to run, and how to make its
 * output readable.
 *
 * Two rules shape every entry below.
 *
 * **The detected command must not run the tests.** `./gradlew build` and
 * `mvn package` both run the suite, which multiplies the wait, reports a test
 * failure as a build failure, and duplicates `RunTests`. So the defaults are
 * `assemble` and `-DskipTests`.
 *
 * **A default target that is not a build is worse than no detection.** `make`
 * with no `all:` target could be an `install` or a `run`; `rake`'s default task
 * is very often the test suite. Those probes decline rather than guess, and the
 * caller is told to pass an explicit `command`.
 */

export type DetectedBuild = {
  system: BuildSystem
  command: string
}

type Probe = (cwd: string) => DetectedBuild | null

const COMMAND_MATCHERS: Array<[RegExp, BuildSystem]> = [
  [/^cargo\b/, 'cargo'],
  [/(?:^|\/)gradlew\b|^gradle\b/, 'gradle'],
  [/(?:^|\/)mvnw\b|^mvn\b/, 'maven'],
  [/^sbt\b/, 'sbt'],
  [/(?:^|\/)mill\b/, 'mill'],
  [/^dotnet\b|^msbuild\b/, 'dotnet'],
  [/^go\s+build\b/, 'go'],
  [/^cmake\b/, 'cmake'],
  [/^ninja\b/, 'ninja'],
  [/^make\b/, 'make'],
  [/^swift\s+build\b/, 'swift'],
  [/^xcodebuild\b/, 'xcodebuild'],
  [/^zig\s+build\b/, 'zig'],
  [/^mix\b/, 'mix'],
  [/^rebar3\b/, 'rebar3'],
  [/^flutter\b/, 'flutter'],
  [/^dart\b/, 'dart'],
  [/^rake\b/, 'rake'],
  [/^luarocks\b/, 'luarocks'],
  [/^cabal\b/, 'cabal'],
  [/^stack\b/, 'stack'],
  [/^(?:npm|pnpm|yarn|bun)\b/, 'node'],
]

export function detectBuildSystemFromCommand(command: string): BuildSystem {
  const trimmed = command.trim()
  for (const [re, system] of COMMAND_MATCHERS) {
    if (re.test(trimmed)) return system
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
  const raw = safeRead(file)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function hasTopLevelFileWithExt(cwd: string, exts: string[]): boolean {
  try {
    return readdirSync(cwd).some(name => exts.some(ext => name.endsWith(ext)))
  } catch {
    return false
  }
}

function detectPackageManager(cwd: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(path.join(cwd, 'bun.lock')) || existsSync(path.join(cwd, 'bun.lockb'))) return 'bun'
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** `<manager> run build`, but only when a `build` script actually exists. */
function detectNodeBuild(cwd: string): DetectedBuild | null {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'))
  const scripts = pkg?.scripts
  if (typeof scripts !== 'object' || scripts === null) return null
  const build = (scripts as Record<string, unknown>).build
  if (typeof build !== 'string' || build.trim() === '') return null
  return { system: 'node', command: `${detectPackageManager(cwd)} run build` }
}

/** A wrapper pins the tool's version and is frequently the only one present. */
function wrapper(cwd: string, name: string, fallback: string): string {
  return existsSync(path.join(cwd, name)) ? `./${name}` : fallback
}

/**
 * cmake only builds a directory that has already been CONFIGURED — a build tree
 * with no `CMakeCache.txt` makes `cmake --build` exit immediately with "not a
 * directory containing a CMakeCache", which reads as a broken build rather than
 * as a project that was never configured. Declining here lets the make or ninja
 * probe answer for the same project.
 */
const CMAKE_BUILD_DIRS = ['build', 'out/build', 'cmake-build-debug', 'cmake-build-release']

function detectCmake(cwd: string): DetectedBuild | null {
  if (!existsSync(path.join(cwd, 'CMakeLists.txt'))) return null
  for (const dir of CMAKE_BUILD_DIRS) {
    if (existsSync(path.join(cwd, dir, 'CMakeCache.txt'))) {
      return { system: 'cmake', command: `cmake --build ${dir}` }
    }
  }
  return null
}

/** A Makefile with no `all` target has a default target that could be anything. */
const MAKE_ALL_TARGET_RE = /^all\s*:/m

function detectMake(cwd: string): DetectedBuild | null {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    const file = path.join(cwd, name)
    if (!existsSync(file)) continue
    return MAKE_ALL_TARGET_RE.test(safeRead(file)) ? { system: 'make', command: 'make all' } : null
  }
  return null
}

/**
 * `rake` with no task runs the default one, which in most Ruby projects is the
 * test suite. Only a Rakefile that clearly defines a build task qualifies —
 * `Bundler::GemHelper.install_tasks` is what defines `rake build` for a gem.
 */
const RAKE_BUILD_TASK_RE = /task\s+:build\b|GemHelper\.install_tasks|require\s+["']bundler\/gem_tasks["']/

function detectRake(cwd: string): DetectedBuild | null {
  const file = path.join(cwd, 'Rakefile')
  if (!existsSync(file)) return null
  return RAKE_BUILD_TASK_RE.test(safeRead(file)) ? { system: 'rake', command: 'rake build' } : null
}

function detectDart(cwd: string): DetectedBuild | null {
  const pubspec = path.join(cwd, 'pubspec.yaml')
  if (!existsSync(pubspec)) return null
  const spec = safeRead(pubspec)
  if (/^flutter\s*:/m.test(spec) || /sdk:\s*flutter/.test(spec)) {
    // The one target that needs no platform toolchain and no device.
    return { system: 'flutter', command: 'flutter build bundle' }
  }
  // A plain Dart package only produces something when it has an entrypoint.
  const entry = path.join(cwd, 'bin', 'main.dart')
  return existsSync(entry) ? { system: 'dart', command: 'dart compile exe bin/main.dart' } : null
}

function fileHasExt(cwd: string, ext: string): boolean {
  return hasTopLevelFileWithExt(cwd, [ext])
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

function detectXcode(cwd: string): DetectedBuild | null {
  try {
    const found = readdirSync(cwd).find(
      name =>
        (name.endsWith('.xcworkspace') || name.endsWith('.xcodeproj')) &&
        isDirectory(path.join(cwd, name)),
    )
    return found ? { system: 'xcodebuild', command: 'xcodebuild build' } : null
  } catch {
    return null
  }
}

/**
 * Ordered detection probes. The overlap with `TypecheckTool`'s and
 * `RunTestsTool`'s probe order is deliberate: in a polyglot repo all three
 * tools must pick the same language, or an agent that built the JVM half and
 * tested the Node half is comparing two different projects.
 */
const PROBES: Probe[] = [
  detectNodeBuild,
  detectDart,
  cwd => (existsSync(path.join(cwd, 'go.mod')) ? { system: 'go', command: 'go build ./...' } : null),
  cwd =>
    existsSync(path.join(cwd, 'Cargo.toml')) ? { system: 'cargo', command: 'cargo build' } : null,
  cwd =>
    existsSync(path.join(cwd, 'pom.xml'))
      ? { system: 'maven', command: `${wrapper(cwd, 'mvnw', 'mvn')} package -DskipTests` }
      : null,
  cwd =>
    existsSync(path.join(cwd, 'build.gradle')) || existsSync(path.join(cwd, 'build.gradle.kts'))
      ? { system: 'gradle', command: `${wrapper(cwd, 'gradlew', 'gradle')} assemble` }
      : null,
  cwd => (existsSync(path.join(cwd, 'build.sbt')) ? { system: 'sbt', command: 'sbt compile' } : null),
  cwd =>
    existsSync(path.join(cwd, 'build.sc')) || existsSync(path.join(cwd, 'build.mill'))
      ? { system: 'mill', command: `${wrapper(cwd, 'mill', 'mill')} __.compile` }
      : null,
  cwd => (existsSync(path.join(cwd, 'mix.exs')) ? { system: 'mix', command: 'mix compile' } : null),
  cwd =>
    existsSync(path.join(cwd, 'rebar.config'))
      ? { system: 'rebar3', command: 'rebar3 compile' }
      : null,
  cwd =>
    hasTopLevelFileWithExt(cwd, ['.csproj', '.sln', '.fsproj'])
      ? { system: 'dotnet', command: 'dotnet build' }
      : null,
  cwd =>
    existsSync(path.join(cwd, 'Package.swift'))
      ? { system: 'swift', command: 'swift build' }
      : null,
  detectXcode,
  cwd => (existsSync(path.join(cwd, 'build.zig')) ? { system: 'zig', command: 'zig build' } : null),
  detectCmake,
  cwd => (existsSync(path.join(cwd, 'build.ninja')) ? { system: 'ninja', command: 'ninja' } : null),
  detectMake,
  cwd => (fileHasExt(cwd, '.rockspec') ? { system: 'luarocks', command: 'luarocks make' } : null),
  detectRake,
  cwd =>
    existsSync(path.join(cwd, 'stack.yaml')) ? { system: 'stack', command: 'stack build' } : null,
  cwd =>
    existsSync(path.join(cwd, 'cabal.project')) || fileHasExt(cwd, '.cabal')
      ? { system: 'cabal', command: 'cabal build' }
      : null,
]

export function detectBuild(cwd: string): DetectedBuild | null {
  for (const probe of PROBES) {
    const found = probe(cwd)
    if (found) return found
  }
  return null
}

/**
 * The detected entry for ONE requested build system, used by the `system`
 * override. Returning null when that system is not configured here is the
 * point: pairing an override with the first-detected command would run, say,
 * `bun run build` and parse its output as cargo JSON.
 */
export function detectBuildFor(cwd: string, system: BuildSystem): DetectedBuild | null {
  for (const probe of PROBES) {
    const found = probe(cwd)
    if (found?.system === system) return found
  }
  return null
}

/**
 * Every build system this project could run, in probe order. The tool runs only
 * the first and names the rest in its RESULT, so the model can discover the
 * `system` override without the tool DESCRIPTION having to vary per project —
 * which would fragment the shared system-prompt cache.
 */
export function detectAllBuildSystems(cwd: string): BuildSystem[] {
  const found: BuildSystem[] = []
  for (const probe of PROBES) {
    const hit = probe(cwd)
    if (hit && !found.includes(hit.system)) found.push(hit.system)
  }
  return found
}

/**
 * Directories a build writes INTO. Recursing into them would report a build
 * system that is an artifact of the one above it.
 */
const NOT_A_SUBPROJECT = new Set([
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  'vendor',
  'bin',
  'obj',
  '.git',
])

/**
 * Immediate subdirectories that hold a build of their own.
 *
 * Only used to answer "nothing to build here" with something actionable: a
 * workspace root usually has no build system of its own, and the useful reply
 * names the packages that do. One level deep and capped — a hint, not a search.
 */
export function detectSubprojects(cwd: string, limit = 8): string[] {
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(cwd).sort()
  } catch {
    return found
  }
  for (const name of entries) {
    if (found.length >= limit) break
    if (name.startsWith('.') || NOT_A_SUBPROJECT.has(name)) continue
    const child = path.join(cwd, name)
    if (!isDirectory(child)) continue
    if (detectBuild(child)) found.push(name)
  }
  return found
}

type QuietFlag = {
  flag: string
  presentRe: RegExp
}

/**
 * Flags that make a build system's output machine-readable, or at least quiet.
 * Each is skipped when the command already carries an equivalent, so a
 * user-supplied `command` is never contradicted.
 *
 * What is deliberately absent: maven's `-q` and dotnet's `-clp:NoSummary`, both
 * of which `Typecheck` does use. A check only needs the diagnostics; a build
 * result also has to say whether the artifact was produced, and those flags
 * remove the very lines that say so.
 */
const QUIET_FLAGS: Partial<Record<BuildSystem, QuietFlag>> = {
  cargo: { flag: '--message-format=json', presentRe: /--message-format\b/ },
  // Without this, gradle's progress bar rewrites the line with carriage
  // returns and every text parser downstream reads one giant line.
  gradle: { flag: '--console=plain', presentRe: /--console\b/ },
  maven: { flag: '-B', presentRe: /(?:^|\s)-B\b|--batch-mode\b/ },
  dotnet: { flag: '-nologo', presentRe: /-nologo\b/ },
  sbt: { flag: '-batch', presentRe: /-batch\b/ },
  xcodebuild: { flag: '-quiet', presentRe: /-quiet\b/ },
}

/** True when the command runs a package script rather than the tool itself. */
const PACKAGE_SCRIPT_RE = /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+\S+/

/**
 * Append the quiet/machine-format flag. For a package script the flag must
 * cross the package manager with a `--` separator or it is consumed as the
 * manager's own argument; every manager forwards what follows to the script.
 */
export function applyQuietFlags(system: BuildSystem, command: string): string {
  const plan = QUIET_FLAGS[system]
  if (!plan || plan.presentRe.test(command)) return command
  const separator = PACKAGE_SCRIPT_RE.test(command) ? ' --' : ''
  return `${command}${separator} ${plan.flag}`
}
