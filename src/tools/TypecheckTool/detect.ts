import { existsSync, readdirSync, readFileSync } from 'fs'
import * as path from 'path'
import { logError } from 'src/shared/log.js'
import { whichSync } from 'src/shared/proc/which.js'
import type { Checker } from 'src/tools/TypecheckTool/types.js'

/**
 * Checker detection and command resolution.
 *
 * Two jobs, deliberately in one module because they share the same knowledge:
 * which marker file means which checker (detection), and which flag makes that
 * checker emit a machine-readable, one-line-per-diagnostic form (resolution).
 * `detectCheckerFromCommand` additionally feeds the Bash redirect, so a command
 * the redirect recognises is by construction one this tool can run.
 */

export type DetectedChecker = {
  checker: Checker
  command: string
  /**
   * Set when the command is a package script we could not rewrite into a single
   * checker invocation (`tsc --noEmit && eslint .`). It still runs, but the
   * compact-output flag could not be injected, so parsing may fall back.
   */
  composedScript?: boolean
  /**
   * Project-relative directory holding the toolchain this command needs
   * (`node_modules/.bin`, `.venv/bin`, `vendor/bin`) — set only when the binary
   * is project-local rather than on the global PATH.
   *
   * It exists for baseline reconstruction, which runs this same command inside
   * a checkout of HEAD. That checkout carries tracked sources and nothing else,
   * so a project-local binary is absent there and the run exits 127. Only the
   * probe that chose the path knows which directory has to be re-pointed, so it
   * records it here instead of leaving the runner to guess by pattern — a guess
   * that covered `node_modules` and silently missed `.venv` and `vendor`, while
   * being unable to tell either from `./gradlew`, which is tracked and must
   * keep resolving inside the checkout.
   */
  toolchainDir?: string
}

const NODE_BIN_DIR = 'node_modules/.bin'

const COMMAND_MATCHERS: Array<[RegExp, Checker]> = [
  [/\bcargo\s+check\b/, 'cargo'],
  [/\bdeno\s+check\b/, 'deno'],
  [/\bgo\s+(?:vet|build)\b/, 'go'],
  [/\b(?:dart|flutter)\s+analyze\b/, 'dart'],
  [/\bdotnet\s+build\b/, 'dotnet'],
  [/(?:^|\/|\s)(?:mvn|mvnw)\b/, 'maven'],
  [/(?:^|\/|\s)gradlew?\b/, 'gradle'],
  [/\bphpstan\b/, 'phpstan'],
  [/\bpsalm\b/, 'psalm'],
  [/\bpyright\b/, 'pyright'],
  [/\bmypy\b/, 'mypy'],
  // Last: `tsc` is a substring of nothing else here, but vue-tsc/tsgo are
  // tsc-compatible front ends and must map to the same parser.
  [/\b(?:vue-tsc|tsgo|tsc)\b/, 'tsc'],
  // A JS package script named `typecheck` carries no checker token at all.
  // Mapping it to tsc is an inference, but a safe one — it is what such a
  // script runs — and without it an explicitly passed `bun run typecheck`
  // would get no compact-output flag and be parsed from pretty layout.
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types)\b/, 'tsc'],
]

export function detectCheckerFromCommand(command: string): Checker {
  for (const [re, checker] of COMMAND_MATCHERS) {
    if (re.test(command)) return checker
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
    return JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    logError(`Typecheck: failed to parse ${file} — ${String(e)}`)
    return null
  }
}

function hasTopLevelFileWithExt(cwd: string, exts: string[]): boolean {
  try {
    return readdirSync(cwd).some(f => exts.some(ext => f.endsWith(ext)))
  } catch {
    return false
  }
}

function detectPackageManager(cwd: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(path.join(cwd, 'bun.lock')) || existsSync(path.join(cwd, 'bun.lockb'))) {
    return 'bun'
  }
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/** Script names projects actually use for a type-only check, in preference order. */
const TYPECHECK_SCRIPT_NAMES = ['typecheck', 'type-check', 'check-types', 'tsc', 'types']

/** Anything here means the script does more than run one checker. */
const SCRIPT_COMPOSITION_RE = /[;|&]|\$\(|`|\n/

/** The script body must BE a checker invocation, not merely contain one. */
const SCRIPT_IS_TSC_RE = /^(?:npx\s+|bunx\s+|pnpm\s+exec\s+|yarn\s+)?(?:vue-tsc|tsgo|tsc)\b/

type PackageScript = { name: string; body: string }

function findTypecheckScript(cwd: string): PackageScript | null {
  const pkg = readJsonSafe(path.join(cwd, 'package.json'))
  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') return null
  const table = scripts as Record<string, unknown>
  for (const name of TYPECHECK_SCRIPT_NAMES) {
    const body = table[name]
    if (typeof body === 'string' && body.trim()) return { name, body: body.trim() }
  }
  return null
}

/**
 * Resolve the TypeScript command.
 *
 * Preference order matters and is not arbitrary:
 *
 * 1. The project's own script, run through its package manager. That honours
 *    flags the project needs (`-p tsconfig.build.json`) so the result agrees
 *    with CI, and it keeps `node_modules/.bin` on PATH — which running the
 *    script BODY directly would not, so a bare `tsc` would be "command not
 *    found" in any project that has no global install.
 *    Every package manager forwards args after `--` to the script, so the
 *    compact-output flag still reaches tsc (verified with bun, which swallows
 *    the separator).
 * 2. The locally installed binary.
 * 3. A global one.
 *
 * A composed script (`tsc --noEmit && eslint .`) cannot take an injected flag —
 * the flag would land on the LAST command in the chain — so it runs verbatim
 * and is flagged for the caller to parse leniently.
 */
function detectTscCommand(cwd: string): DetectedChecker | null {
  const script = findTypecheckScript(cwd)
  if (script) {
    const pm = detectPackageManager(cwd)
    const composed =
      SCRIPT_COMPOSITION_RE.test(script.body) || !SCRIPT_IS_TSC_RE.test(script.body)
    return {
      checker: 'tsc',
      command: `${pm} run ${script.name}`,
      composedScript: composed,
      // The script body resolves its own binary through the package manager's
      // PATH, which points at the directory the run happens in — so this is
      // needed even though no path appears in the command itself.
      ...(existsSync(path.join(cwd, NODE_BIN_DIR)) ? { toolchainDir: NODE_BIN_DIR } : {}),
    }
  }
  const local = path.join(cwd, 'node_modules', '.bin', 'tsc')
  if (existsSync(local)) {
    return {
      checker: 'tsc',
      command: `./${NODE_BIN_DIR}/tsc --noEmit`,
      toolchainDir: NODE_BIN_DIR,
    }
  }
  if (whichSync('tsc')) return { checker: 'tsc', command: 'tsc --noEmit' }
  return null
}

/**
 * Resolve a binary that may live in a project-local virtualenv before falling
 * back to PATH. Mirrors how RunTestsTool's pytest detection hunts for a venv:
 * a bare `mypy` against a uv/poetry project resolves to the wrong interpreter's
 * copy, or to nothing at all.
 */
function resolvePythonTool(
  cwd: string,
  tool: string,
): { bin: string; toolchainDir?: string } | null {
  for (const dir of ['.venv/bin', 'venv/bin']) {
    if (existsSync(path.join(cwd, dir, tool))) return { bin: `./${dir}/${tool}`, toolchainDir: dir }
  }
  return whichSync(tool) ? { bin: tool } : null
}

const PYPROJECT_PYRIGHT_RE = /^\s*\[tool\.pyright\]/m
const PYPROJECT_MYPY_RE = /^\s*\[tool\.mypy\]/m
const SETUP_CFG_MYPY_RE = /^\s*\[mypy\]/m

/**
 * Python has no single blessed checker, so config presence picks the preferred
 * one and availability decides the rest: pyright → mypy → nothing. Returning
 * null (rather than a command that cannot run) is what lets the caller say
 * "install one of these" instead of surfacing a shell `command not found`.
 */
function detectPythonChecker(cwd: string): DetectedChecker | null {
  const pyproject = safeRead(path.join(cwd, 'pyproject.toml'))
  const prefersPyright =
    existsSync(path.join(cwd, 'pyrightconfig.json')) || PYPROJECT_PYRIGHT_RE.test(pyproject)
  const prefersMypy =
    existsSync(path.join(cwd, 'mypy.ini')) ||
    existsSync(path.join(cwd, '.mypy.ini')) ||
    PYPROJECT_MYPY_RE.test(pyproject) ||
    SETUP_CFG_MYPY_RE.test(safeRead(path.join(cwd, 'setup.cfg')))

  const order: Checker[] = prefersMypy && !prefersPyright ? ['mypy', 'pyright'] : ['pyright', 'mypy']
  for (const checker of order) {
    const found = resolvePythonTool(cwd, checker)
    if (!found) continue
    return {
      checker,
      command: checker === 'mypy' ? `${found.bin} .` : found.bin,
      ...(found.toolchainDir ? { toolchainDir: found.toolchainDir } : {}),
    }
  }
  return null
}

function detectPhpChecker(cwd: string): DetectedChecker | null {
  const phpstanConfig =
    existsSync(path.join(cwd, 'phpstan.neon')) || existsSync(path.join(cwd, 'phpstan.neon.dist'))
  const psalmConfig =
    existsSync(path.join(cwd, 'psalm.xml')) || existsSync(path.join(cwd, 'psalm.xml.dist'))
  if (phpstanConfig) {
    const local = path.join(cwd, 'vendor', 'bin', 'phpstan')
    const isLocal = existsSync(local)
    const bin = isLocal ? 'vendor/bin/phpstan' : whichSync('phpstan') ? 'phpstan' : null
    if (bin) {
      return {
        checker: 'phpstan',
        command: `${bin} analyse`,
        ...(isLocal ? { toolchainDir: 'vendor/bin' } : {}),
      }
    }
  }
  if (psalmConfig) {
    const local = path.join(cwd, 'vendor', 'bin', 'psalm')
    const isLocal = existsSync(local)
    const bin = isLocal ? 'vendor/bin/psalm' : whichSync('psalm') ? 'psalm' : null
    if (bin) {
      return { checker: 'psalm', command: bin, ...(isLocal ? { toolchainDir: 'vendor/bin' } : {}) }
    }
  }
  return null
}

/**
 * Ordered detection probes. Order mirrors RunTestsTool's `detectTestRunner` so
 * that a polyglot repo picks the same language in both tools — an agent that
 * ran the JS suite and then the Python checker would otherwise be comparing
 * two different halves of the project.
 */
const PROBES: Array<(cwd: string) => DetectedChecker | null> = [
  cwd => (existsSync(path.join(cwd, 'tsconfig.json')) ? detectTscCommand(cwd) : null),
  cwd =>
    existsSync(path.join(cwd, 'deno.json')) || existsSync(path.join(cwd, 'deno.jsonc'))
      ? { checker: 'deno', command: 'deno check' }
      : null,
  cwd => {
    if (!existsSync(path.join(cwd, 'pubspec.yaml'))) return null
    const pub = safeRead(path.join(cwd, 'pubspec.yaml'))
    const isFlutter = /^flutter\s*:/m.test(pub) || /sdk:\s*flutter/.test(pub)
    return { checker: 'dart', command: isFlutter ? 'flutter analyze' : 'dart analyze' }
  },
  cwd =>
    existsSync(path.join(cwd, 'pyproject.toml')) ||
    existsSync(path.join(cwd, 'setup.cfg')) ||
    existsSync(path.join(cwd, 'mypy.ini')) ||
    existsSync(path.join(cwd, 'pyrightconfig.json'))
      ? detectPythonChecker(cwd)
      : null,
  cwd => (existsSync(path.join(cwd, 'go.mod')) ? { checker: 'go', command: 'go build ./...' } : null),
  cwd =>
    existsSync(path.join(cwd, 'Cargo.toml')) ? { checker: 'cargo', command: 'cargo check' } : null,
  cwd => {
    if (!existsSync(path.join(cwd, 'pom.xml'))) return null
    // The wrapper pins the build tool's version and is frequently the only one
    // present — such a project has no global `mvn` to call at all.
    const wrapper = existsSync(path.join(cwd, 'mvnw')) ? './mvnw' : 'mvn'
    return { checker: 'maven', command: `${wrapper} compile` }
  },
  cwd => {
    if (
      !existsSync(path.join(cwd, 'build.gradle')) &&
      !existsSync(path.join(cwd, 'build.gradle.kts'))
    ) {
      return null
    }
    const wrapper = existsSync(path.join(cwd, 'gradlew')) ? './gradlew' : 'gradle'
    return { checker: 'gradle', command: `${wrapper} compileJava` }
  },
  cwd =>
    hasTopLevelFileWithExt(cwd, ['.csproj', '.sln', '.fsproj'])
      ? { checker: 'dotnet', command: 'dotnet build' }
      : null,
  cwd => detectPhpChecker(cwd),
]

export function detectChecker(cwd: string): DetectedChecker | null {
  for (const probe of PROBES) {
    const found = probe(cwd)
    if (found) return found
  }
  return null
}

/**
 * The detected entry for ONE requested checker, used by the `checker` override.
 * Returning null when that checker is not configured here is the point:
 * pairing an override with the first-detected checker's command would run, say,
 * `bun run typecheck` and parse its output as cargo JSON.
 */
export function detectCheckerFor(cwd: string, checker: Checker): DetectedChecker | null {
  for (const probe of PROBES) {
    const found = probe(cwd)
    if (found?.checker === checker) return found
  }
  return null
}

/**
 * Every checker this project could run, in probe order. The tool runs only the
 * first (one check per call, like one suite per RunTests call) and names the
 * rest in its result so the model can discover the `checker` override without
 * the tool DESCRIPTION having to vary per project — which would fragment the
 * shared system-prompt cache.
 */
export function detectAllCheckers(cwd: string): Checker[] {
  const found: Checker[] = []
  for (const probe of PROBES) {
    const hit = probe(cwd)
    if (hit && !found.includes(hit.checker)) found.push(hit.checker)
  }
  return found
}

/**
 * Flags that make a checker emit its most machine-readable form. Each is
 * skipped when the command already carries an equivalent, so a user-supplied
 * `command` is never contradicted.
 */
/**
 * `--no-restore` on a project whose packages were never restored does not skip
 * work — it FAILS with NETSDK1004, and that failure prints in the same shape as
 * a real diagnostic but positioned inside the .NET SDK's own targets file. Add
 * it only once a restore has produced its assets file: repeat checks stay fast,
 * and the first check after a clone pays for a restore instead of reporting a
 * phantom error in a system path.
 */
function hasRestoredAssets(cwd: string): boolean {
  if (existsSync(path.join(cwd, 'obj', 'project.assets.json'))) return true
  try {
    // The usual solution layout puts each project one level down.
    return readdirSync(cwd, { withFileTypes: true }).some(
      entry =>
        entry.isDirectory() && existsSync(path.join(cwd, entry.name, 'obj', 'project.assets.json')),
    )
  } catch {
    return false
  }
}

type CompactFlag = {
  flag: string
  presentRe: RegExp
  /** Appended only when the project state supports it; see hasRestoredAssets. */
  conditional?: { flag: string; presentRe: RegExp; when: (cwd: string) => boolean }
}

const COMPACT_FLAGS: Partial<Record<Checker, CompactFlag>> = {
  tsc: { flag: '--pretty false', presentRe: /--pretty\b/ },
  cargo: { flag: '--message-format=json', presentRe: /--message-format\b/ },
  pyright: { flag: '--outputjson', presentRe: /--outputjson\b/ },
  mypy: { flag: '--output=json', presentRe: /--output[= ]/ },
  dart: { flag: '--format=machine', presentRe: /--format[= ]/ },
  dotnet: {
    flag: '-clp:NoSummary',
    presentRe: /-clp:/,
    conditional: { flag: '--no-restore', presentRe: /--no-restore\b/, when: hasRestoredAssets },
  },
  // `-q` limits maven to errors. What is deliberately NOT here is `-o`
  // (offline): it shapes no output, and against a cold `~/.m2` it aborts the
  // run at plugin resolution — "Cannot access central in offline mode" — so the
  // check silently never happens on a fresh clone or in CI. Same reasoning
  // keeps `--offline` off gradle, which needs no flag: it already prints
  // javac's own `file:line: error:` lines.
  maven: { flag: '-q', presentRe: /(?:^|\s)-q\b|--quiet\b/ },
  phpstan: { flag: '--error-format=json --no-progress', presentRe: /--error-format\b/ },
  psalm: { flag: '--output-format=json --no-progress', presentRe: /--output-format\b/ },
}

/** True when the command runs a package script rather than the checker itself. */
const PACKAGE_SCRIPT_RE = /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+\S+/

/**
 * Append the compact-output flag. For a package script the flag must cross the
 * package manager with a `--` separator or it is consumed as the manager's own
 * argument; every manager forwards what follows to the script.
 */
export function applyCompactFlags(checker: Checker, command: string, cwd?: string): string {
  const plan = COMPACT_FLAGS[checker]
  if (!plan) return command
  const separator = PACKAGE_SCRIPT_RE.test(command) ? ' --' : ''
  let composed = plan.presentRe.test(command) ? command : `${command}${separator} ${plan.flag}`
  const extra = plan.conditional
  if (extra && cwd !== undefined && !extra.presentRe.test(command) && extra.when(cwd)) {
    composed = `${composed} ${extra.flag}`
  }
  return composed
}
