import { TYPECHECK_TOOL_NAME } from './prompt.js'
import {
  createOneShotMemo,
  createOutputTrimTailStripper,
  DEFAULT_OUTPUT_TRIM_FILTERS,
  hasShellComposition,
  MEMO_LIMIT,
} from '../shared/redirect.js'

export { MEMO_LIMIT }

/**
 * Bash → Typecheck redirect.
 *
 * The model reaches for `bun run typecheck` out of habit even with the tool in
 * its toolset. An appended <system-reminder> is NOT the lever — that shape was
 * measured in this codebase at zero adoption; what moves behaviour is a refusal
 * that names the alternative. So BashTool's validateInput declines a bare check
 * command and points here.
 *
 * Disable with `CLAUDIN_DISABLE_TYPECHECK_REDIRECT=1` (read at the BashTool call
 * site, alongside the sibling RunTests and Read/Grep/Glob redirects).
 *
 * Deliberately narrow, in the same three ways as the RunTests redirect:
 *
 *  - Single command only. Shell composition or redirection opts out, because
 *    the tool cannot run the other half of `bun run build && bun run typecheck`.
 *  - The checker must be what the command STARTS with. Without that anchor
 *    `grep -rn "cargo check" src` reads as a check and gets refused, which is
 *    the worst possible false positive: a search blocked by the typecheck tool.
 *  - No flag asking for what the tool removes. `--watch` never terminates, and
 *    `--pretty`/`--listFiles`/`--explain` are explicit raw-output intent.
 *
 * And one way of its own: **only pure checkers**. `go build`, `dotnet build`,
 * `mvn` and `gradle` also produce artifacts, and people run them for that — the
 * tool can drive them when asked, but refusing them in Bash would block work
 * that has nothing to do with type checking.
 *
 * ONE-SHOT per command: re-sending the identical command runs it. Without that
 * escape there would be no way to get raw compiler output at all, and the
 * refusal would be a wall rather than a signpost.
 */

/**
 * The output-trimming tail the model habitually appends to a verbose checker
 * (`2>&1 | tail -40`, `| grep "error TS"`). It expresses "give me LESS output",
 * which is exactly what this tool returns, so it must not read as a second
 * command. Only output REDUCERS qualify — `tee` and `>` persist the output
 * somewhere else and stay composition.
 *
 * `wc` is added to the shared default set here: `tsc --noEmit | wc -l` asks
 * "how many errors", and a baseline-filtered diagnostic list answers that
 * better than a raw count does.
 */
export const stripOutputTrimTail = createOutputTrimTailStripper([
  ...DEFAULT_OUTPUT_TRIM_FILTERS,
  'wc',
])

/** Flags that ask for raw output, a watcher, or no check at all. */
const OPT_OUT_FLAG_RE =
  /\s(?:--watch|-w|--pretty|--verbose|--explain|--listFiles|--traceResolution|--showConfig|--diagnostics|--extendedDiagnostics|--init|--help|-h|--version|-V)(?:[\s=]|$)/

/**
 * A command must MATCH one of these to be redirected — an allowlist, not a
 * heuristic, because the cost of a wrong refusal is much higher than the cost
 * of missing one redirect.
 */
const REDIRECTABLE_RES: RegExp[] = [
  // Package script: `bun run typecheck`, `npm run type-check`, `yarn typecheck`.
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types|tsc)\b/,
  // The TypeScript compiler directly, however it is reached.
  /^(?:npx\s+|bunx\s+|pnpm\s+exec\s+|yarn\s+)?(?:[\w.\-/]*\/)?(?:vue-tsc|tsgo|tsc)\b/,
  /^cargo\s+check\b/,
  /^(?:[\w.\-/]*\/)?(?:mypy|pyright)\b/,
  /^deno\s+check\b/,
  /^(?:dart|flutter)\s+analyze\b/,
  // `go build` is excluded on purpose: it produces a binary people want.
  /^go\s+vet\b/,
  /^(?:[\w.\-/]*\/)?(?:phpstan|psalm)\b/,
]

/** Pure predicate: would Typecheck run this command just as well? */
export function isRedirectableCheckCommand(command: string): boolean {
  const cmd = stripOutputTrimTail(command.trim())
  if (!cmd) return false
  if (hasShellComposition(cmd)) return false
  if (OPT_OUT_FLAG_RE.test(cmd)) return false
  return REDIRECTABLE_RES.some(re => re.test(cmd))
}

/**
 * This tool's own refusal memo — see the shared module for why it is not
 * shared with the sibling redirects.
 */
const memo = createOneShotMemo(MEMO_LIMIT)

/**
 * Stateful gate. Records the command as refused, so the SECOND identical call
 * runs — the escape hatch the message promises.
 */
export function shouldRedirectToTypecheck(command: string): boolean {
  if (!isRedirectableCheckCommand(command)) return false
  return memo.shouldRefuse(command)
}

export function resetTypecheckRedirectMemoForTesting(): void {
  memo.reset()
}

export function renderTypecheckRedirect(command: string): string {
  const cmd = command.trim()
  const core = stripOutputTrimTail(cmd)
  return [
    `Blocked: \`${cmd}\` type-checks the project, and ${TYPECHECK_TOOL_NAME} is available.`,
    `Call ${TYPECHECK_TOOL_NAME} instead — it runs the same checker and reports only the diagnostics that are NOT already in the project's recorded backlog, each with file:line and a source excerpt. In a project with pre-existing errors that is the difference between a handful of lines and thousands.`,
    `With no arguments it runs the checker it detects here; pass command: ${JSON.stringify(core)} to run this exact one, plus path to filter the report.`,
    ...(core === cmd
      ? []
      : [
          `The output filter is dropped on purpose — ${TYPECHECK_TOOL_NAME} already trims to what is new, and a Bash result carries stderr without \`2>&1\`.`,
        ]),
    `If you specifically need raw compiler output, re-send this exact Bash command and it will run.`,
  ].join(' ')
}
