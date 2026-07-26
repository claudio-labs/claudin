import { detectFrameworkFromCommand } from './detect.js'
import { RUN_TESTS_TOOL_NAME } from './prompt.js'
import type { Framework } from './types.js'

/**
 * Bash → RunTests redirect.
 *
 * The model reaches for `bun test` / `pytest` out of habit even with RunTests
 * in its toolset. An appended <system-reminder> is NOT the lever here — that
 * shape was measured in this codebase at zero adoption (the SERIAL_READ_NUDGE
 * verdict); what moves behavior is a refusal that names the alternative. So
 * BashTool's validateInput declines a bare test command and points at RunTests.
 *
 * Deliberately narrow — it only fires where RunTests does the same job:
 *
 *  - Single command only. `bun run build && bun test` is a build step RunTests
 *    cannot run, so any shell composition or redirection opts out.
 *  - The runner must be what the command STARTS with. Without that anchor
 *    `grep -rn "bun test" src` reads as a test run and gets refused, which is
 *    the worst possible false positive: a search blocked by the test tool.
 *    Quotes opt out for the same reason (`python -c "go test"`).
 *  - No flag asking for what RunTests removes. It drops stdout on a green run
 *    and keeps only failure excerpts, so `-s`, `--nocapture`, `--watch`,
 *    `--inspect` and an explicit `--reporter` are deliberate raw-output intent;
 *    `--no-run`/`--collect-only`/`--help` don't run a suite at all.
 *  - A token that unambiguously means "run tests". `mvn`/`gradle` also build
 *    and package, so they additionally need a `test` goal.
 *
 * ONE-SHOT per command: re-sending the identical command runs it. Without that
 * escape there would be no way to get raw runner output at all (print
 * debugging, a crash trace), and the refusal would be a wall, not a signpost.
 */

/** Anything here means the command is doing more than running a suite. */
const SHELL_COMPOSITION_RE = /[;|&<>\n`'"]|\$\(/

/**
 * The command must OPEN with a runner (optionally behind `FOO=bar` env
 * assignments) — matching the runner token anywhere would catch every command
 * that merely mentions one.
 */
const TEST_COMMAND_HEAD_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm|npx|pnpm|yarn|bun|bunx|deno|node|python3?|py|py\.test|pytest|go|cargo|dotnet|mvn|gradle|\.\/gradlew|rake|rails|mix|dart|flutter|vitest|jest|mocha|rspec|bundle|phpunit|pest|ctest|vendor\/bin\/(?:phpunit|pest))\b/

/** Flags that ask for raw output, a watcher, or no run at all. */
const OPT_OUT_FLAG_RE =
  /\s(?:--watch(?:All)?|--watch-path|--ui|--pdb|-s|--capture|--nocapture|--show-output|--inspect(?:-brk)?|--reporters?|--json|--coverage|--no-run|--collect-only|--list|--dry-run|--help|-h)(?:[\s=]|$)/

/** Package-script forms `detectFrameworkFromCommand` has no token for. */
const PACKAGE_SCRIPT_TEST_RE = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test$/

/** Runners whose command token also builds/packages — they need a test goal. */
const NEEDS_TEST_GOAL: ReadonlySet<Framework> = new Set(['maven', 'gradle'])

const TEST_GOAL_RE = /\btest\b/

/** Pure predicate: would RunTests run this command just as well? */
export function isRedirectableTestCommand(command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  if (SHELL_COMPOSITION_RE.test(cmd)) return false
  if (!TEST_COMMAND_HEAD_RE.test(cmd)) return false
  if (OPT_OUT_FLAG_RE.test(cmd)) return false
  if (PACKAGE_SCRIPT_TEST_RE.test(cmd)) return true

  const framework = detectFrameworkFromCommand(cmd)
  if (framework === 'unknown') return false
  if (NEEDS_TEST_GOAL.has(framework) && !TEST_GOAL_RE.test(cmd)) return false
  return true
}

/**
 * Commands already refused once. Cleared wholesale past the limit — re-arming
 * after this many distinct test commands in one session is a better failure
 * than a set that grows for the life of the process.
 */
const refusedCommands = new Set<string>()
const MEMO_LIMIT = 100

/**
 * Stateful gate. Records the command as refused, so the SECOND identical call
 * runs — that is the escape hatch the message promises.
 *
 * Safe to consume the one-shot here because `validateInput` has exactly one
 * call site (`services/tools/toolExecution.ts`) and runs once per tool call.
 */
export function shouldRedirectToRunTests(command: string): boolean {
  if (!isRedirectableTestCommand(command)) return false
  const key = command.trim()
  if (refusedCommands.has(key)) return false
  if (refusedCommands.size >= MEMO_LIMIT) refusedCommands.clear()
  refusedCommands.add(key)
  return true
}

export function resetRunTestsRedirectMemoForTesting(): void {
  refusedCommands.clear()
}

export function renderRunTestsRedirect(command: string): string {
  const cmd = command.trim()
  return [
    `Blocked: \`${cmd}\` runs tests, and ${RUN_TESTS_TOOL_NAME} is available.`,
    `Call ${RUN_TESTS_TOOL_NAME} instead — it runs the same suite and returns a failures-first summary (counts, then each failure's name, file:line and source excerpt), so you get the failing location without a follow-up Read.`,
    `With no arguments it runs the suite it detects here; pass command: ${JSON.stringify(cmd)} to run this exact one, plus path/pattern to scope it.`,
    `If you specifically need raw runner output (print debugging, a crash trace), re-send this exact Bash command and it will run.`,
  ].join(' ')
}
