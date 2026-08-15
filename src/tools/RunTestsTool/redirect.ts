import { detectFrameworkFromCommand } from 'src/tools/RunTestsTool/detect.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import type { Framework } from 'src/tools/RunTestsTool/types.js'
import {
  createBoundedKeySet,
  createOneShotMemo,
  createOutputTrimTailStripper,
  hasShellComposition,
  MEMO_LIMIT,
} from 'src/tools/shared/redirect.js'

export { MEMO_LIMIT }

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

/**
 * The output-trimming tail the model habitually appends to a verbose runner:
 * `2>&1 | tail -40`, `| head -20`, `| grep -E "^test "`. Counting it as shell
 * composition is what kept the redirect from EVER firing on Rust — of 33 real
 * `cargo test` calls measured in one project, all 33 carried such a tail and
 * not one was eligible. The intent it expresses is "give me LESS output",
 * which is exactly what RunTests returns, so it must not read as a second
 * command RunTests cannot run. Only output *reducers* qualify: `tee` and `>`
 * persist the output somewhere else and stay composition, and `--nocapture`
 * (want MORE output) still opts out below, tail or no tail.
 *
 * The default filter set deliberately excludes `wc`: `bun test | wc -l` wants a
 * number, and a failures-first summary is not that.
 */
export const stripOutputTrimTail = createOutputTrimTailStripper()

/**
 * The command must OPEN with a runner (optionally behind `FOO=bar` env
 * assignments) — matching the runner token anywhere would catch every command
 * that merely mentions one.
 */
const TEST_COMMAND_HEAD_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npm|npx|pnpm|yarn|bun|bunx|deno|node|python3?|py|py\.test|pytest|uv|poetry|pipenv|pdm|go|cargo|dotnet|mvn|\.\/mvnw|gradle|\.\/gradlew|rake|rails|mix|dart|flutter|vitest|jest|mocha|rspec|bundle|composer|phpunit|pest|ctest|\.?venv\/bin\/pytest|vendor\/bin\/(?:phpunit|pest))\b/

/** Flags that ask for raw output, a watcher, or no run at all. */
const OPT_OUT_FLAG_RE =
  /\s(?:--watch(?:All)?|--watch-path|--ui|--pdb|-s|--capture|--nocapture|--show-output|--inspect(?:-brk)?|--reporters?|--json|--coverage|--no-run|--collect-only|--list|--dry-run|--help|-h)(?:[\s=]|$)/

/** Package-script forms `detectFrameworkFromCommand` has no token for. */
const PACKAGE_SCRIPT_TEST_RE = /^(?:npm|pnpm|yarn|bun|composer)\s+(?:run(?:-script)?\s+)?test$/

/** Runners whose command token also builds/packages — they need a test goal. */
const NEEDS_TEST_GOAL: ReadonlySet<Framework> = new Set(['maven', 'gradle'])

const TEST_GOAL_RE = /\btest\b/

/** Pure predicate: would RunTests run this command just as well? */
export function isRedirectableTestCommand(command: string): boolean {
  const cmd = stripOutputTrimTail(command.trim())
  if (!cmd) return false
  if (hasShellComposition(cmd)) return false
  if (!TEST_COMMAND_HEAD_RE.test(cmd)) return false
  if (OPT_OUT_FLAG_RE.test(cmd)) return false
  if (PACKAGE_SCRIPT_TEST_RE.test(cmd)) return true

  const framework = detectFrameworkFromCommand(cmd)
  if (framework === 'unknown') return false
  if (NEEDS_TEST_GOAL.has(framework) && !TEST_GOAL_RE.test(cmd)) return false
  return true
}

/**
 * This tool's own refusal memo. Deliberately not shared with the Typecheck or
 * Read/Grep/Glob redirects: a refused `bun test` must not spend the escape
 * hatch belonging to some other command.
 */
const memo = createOneShotMemo(MEMO_LIMIT)

/**
 * Suites RunTests has ALREADY run in this process, keyed by the command it
 * resolved.
 *
 * The refusal exists to teach that RunTests is there; once it has run a suite
 * that lesson has landed, and a Bash call on that same suite is the escalation
 * the refusal text itself calls legitimate ("if you specifically need raw
 * runner output"). Charging it a round-trip refuses the one case the message
 * already blessed — which is exactly what happened after a RunTests run
 * reported failures and the follow-up `bun test <path> 2>&1 | grep …` was
 * blocked before running unchanged on the re-send.
 *
 * The pass is CONSUMED on use, and re-armed by the next RunTests run of that
 * suite. Leaving it standing would whitelist the project's main suite in Bash
 * for the rest of the session after a single RunTests call, which is the
 * redirect's whole point undone.
 */
const runByRunTests = createBoundedKeySet(MEMO_LIMIT)

/**
 * Records the command RunTests is about to run, arming ONE Bash escalation on
 * that same suite. Called from `RunTestsTool`'s `call()` — before the run, so
 * that a crashed or timed-out run (the strongest reason to want raw output) is
 * covered too.
 *
 * Commands Bash would never redirect anyway are not recorded: they could not
 * match, and would only evict live entries.
 */
export function noteRunTestsExecution(command: string): void {
  const core = stripOutputTrimTail(command.trim())
  if (isRedirectableTestCommand(core)) runByRunTests.add(core)
}

/**
 * Stateful gate. Records the command as refused, so the SECOND identical call
 * runs — that is the escape hatch the message promises.
 *
 * Safe to consume the one-shot here because `validateInput` runs once per tool
 * call at each of its call sites — `services/tools/toolExecution.ts` and
 * `entrypoints/mcp.ts`. The memo is module-level, so PROCESS-WIDE and shared
 * by both entrypoints; under MCP the refusal surfaces as a thrown Error
 * carrying this same message (mcp.ts wraps a failed validation in
 * `throw new Error`), not as a tool_result.
 */
export function shouldRedirectToRunTests(command: string): boolean {
  if (!isRedirectableTestCommand(command)) return false
  if (runByRunTests.delete(stripOutputTrimTail(command.trim()))) {
    // Spend the memo entry as well: this exact command has had its pass, so a
    // later identical call must not be refused as if it were a first attempt.
    memo.shouldRefuse(command)
    return false
  }
  return memo.shouldRefuse(command)
}

export function resetRunTestsRedirectMemoForTesting(): void {
  memo.reset()
  runByRunTests.clear()
}

export function renderRunTestsRedirect(command: string): string {
  const cmd = command.trim()
  const core = stripOutputTrimTail(cmd)
  return [
    `Blocked: \`${cmd}\` runs tests, and ${RUN_TESTS_TOOL_NAME} is available.`,
    `Call ${RUN_TESTS_TOOL_NAME} instead — it runs the same suite and returns a failures-first summary (counts, then each failure's name, file:line and source excerpt), so you get the failing location without a follow-up Read.`,
    `With no arguments it runs the suite it detects here; pass command: ${JSON.stringify(core)} to run this exact one, plus path/pattern to scope it.`,
    ...(core === cmd
      ? []
      : [
          `The output filter is dropped on purpose — ${RUN_TESTS_TOOL_NAME} already trims to what failed, and a Bash result carries stderr without \`2>&1\`.`,
        ]),
    `If you specifically need raw runner output (print debugging, a crash trace), re-send this exact Bash command and it will run.`,
  ].join(' ')
}
