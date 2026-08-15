import {
  createOneShotMemo,
  createOutputTrimTailStripper,
  hasShellComposition,
  MEMO_LIMIT,
} from 'src/tools/shared/redirect.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'

export { MEMO_LIMIT }

/**
 * Bash → Build redirect.
 *
 * Same lever as the RunTests and Typecheck redirects: an appended
 * `<system-reminder>` was measured in this codebase at zero adoption, so what
 * moves behaviour is a refusal that names the alternative. BashTool's
 * validateInput declines a bare build command once and points here.
 *
 * What the refusal says is only what to CALL. Why the tool is worth calling
 * belongs upstream of any command, in BashTool's own "Prefer:" list — a model
 * that has read the description already knows before it reaches this file.
 *
 * Disable with `CLAUDIN_DISABLE_BUILD_REDIRECT=1` (read at the BashTool call
 * site, alongside the sibling redirects).
 *
 * Narrow in the same three ways as its siblings — single command only, the tool
 * must be what the command STARTS with, and no flag asking for what the tool
 * removes — plus one of its own:
 *
 * **Only the toolchains whose output is actually noisy.** `npm run build` and
 * friends are deliberately absent. Measured over 502 recorded sessions of this
 * project, a JS build's result is a median of 286 characters and a green
 * `bun run build` is 7 lines: refusing it would spend a whole extra round trip
 * to save nothing. cargo, gradle, maven, msbuild, cmake, make and sbt are the
 * ones that print hundreds of lines around the handful that matter.
 *
 * And two hard exclusions. A command that also RUNS, INSTALLS, PUBLISHES or
 * DEPLOYS is never refused — those are side effects the caller wants and the
 * tool's detected target would not reproduce. Neither is one whose TARGET is
 * not a build: the make, gradle, mvn and sbt entries below accept any target,
 * so `make lint`, `./gradlew lint` and `mvn checkstyle:check` were all being
 * refused and their linter output handed to the compiler diagnostic parsers.
 *
 * ONE-SHOT per command: re-sending the identical command runs it. Without that
 * escape there would be no way to get the raw build log at all.
 */

export const stripOutputTrimTail = createOutputTrimTailStripper()

/**
 * `cd <dir> && <build>` — the shape a build takes in every monorepo, and the
 * one the composition check used to drop on the floor. An A/B over a five-
 * package workspace measured 18 of 22 builds arriving this way, none of them
 * redirected, so the tool priced its description against almost none of its
 * benefit.
 *
 * Exactly ONE `cd`, and what follows must be free of further composition — the
 * remainder goes through the same allowlist as a bare command, so `cd x && rm
 * -rf y && make` is still refused a redirect.
 */
const CD_PREFIX_RE = /^cd\s+(?<dir>'[^']+'|"[^"]+"|[^\s&;|<>]+)\s*&&\s*(?<rest>.+)$/

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted ? quoted[2]! : value
}

/** What the tool would be called with, or null when Bash should just run it. */
export type RedirectableBuild = { command: string; directory?: string }

/** Flags that ask for raw output, a watcher, or no build at all. */
const OPT_OUT_FLAG_RE =
  /\s(?:--watch|-w|--verbose|-v|--debug|--info|--stacktrace|--dry-run|-n|--help|-h|--version|-V)(?:[\s=]|$)/

/**
 * Verbs that make the command something other than a build. `cargo install`,
 * `make install`, `mvn deploy` and `gradle publish` all have side effects the
 * caller asked for by name.
 *
 * The leading lookbehind is what keeps this from eating `cargo build
 * --release` and `javac --release 17`: as a FLAG these words are build options,
 * and only as a bare argument are they a different action.
 */
const SIDE_EFFECT_RE =
  /(?<![-\w])(?:install|publish|deploy|release|run|serve|start|clean|uninstall)\b/

/**
 * Targets that are not a build, for the entries that accept any target. Same
 * lookbehind as above, and for the same reason: as a FLAG these words are
 * build options (`--check`, `--tests`), and only as a bare argument are they a
 * different job.
 *
 * `test` is here rather than in the RunTests lane on purpose — that lane's
 * head regex has no `make` token and its framework detection has nothing to
 * say about an arbitrary Makefile target, so `make test` runs in Bash.
 *
 * The word boundary is what limits this: a camelCase Gradle/sbt task
 * (`lintDebug`, `ktlintCheck`, `scalafmtCheck`) is still refused, since
 * `lint` followed by `D` closes no boundary.
 */
const NON_BUILD_TARGET_RE =
  /(?<![-\w])(?:lint|fmt|format|check|docs?|help|bench|coverage|tests?)\b/

/**
 * A command must MATCH one of these to be redirected — an allowlist, not a
 * heuristic, because the cost of a wrong refusal is much higher than the cost
 * of missing one redirect.
 */
const REDIRECTABLE_RES: RegExp[] = [
  /^cargo\s+build\b/,
  /^(?:\.\/)?gradlew?\s/,
  /^(?:\.\/)?mvnw?\s/,
  /^dotnet\s+build\b/,
  /^msbuild\b/,
  /^cmake\s+--build\b/,
  /^ninja\b/,
  /^make\b/,
  /^sbt\s/,
  /^swift\s+build\b/,
  /^zig\s+build\b/,
  /^xcodebuild\b/,
]

/** Pure predicate: would Build run this command just as well? */
export function parseRedirectableBuild(command: string): RedirectableBuild | null {
  const trimmed = stripOutputTrimTail(command.trim())
  if (!trimmed) return null

  const cd = CD_PREFIX_RE.exec(trimmed)
  const directory = cd ? unquote(cd.groups!.dir!) : undefined
  const cmd = cd ? cd.groups!.rest!.trim() : trimmed

  if (hasShellComposition(cmd)) return null
  if (OPT_OUT_FLAG_RE.test(cmd)) return null
  if (SIDE_EFFECT_RE.test(cmd)) return null
  if (NON_BUILD_TARGET_RE.test(cmd)) return null
  if (!REDIRECTABLE_RES.some(re => re.test(cmd))) return null
  return directory === undefined ? { command: cmd } : { command: cmd, directory }
}

export function isRedirectableBuildCommand(command: string): boolean {
  return parseRedirectableBuild(command) !== null
}

/** This tool's own refusal memo — see the shared module for why it is not shared. */
const memo = createOneShotMemo(MEMO_LIMIT)

/**
 * Stateful gate. Records the command as refused, so the SECOND identical call
 * runs — the escape hatch the message promises.
 */
export function shouldRedirectToBuild(command: string): boolean {
  if (!isRedirectableBuildCommand(command)) return false
  return memo.shouldRefuse(command)
}

export function resetBuildRedirectMemoForTesting(): void {
  memo.reset()
}

export function renderBuildRedirect(command: string): string {
  const cmd = command.trim()
  const core = stripOutputTrimTail(cmd)
  const parsed = parseRedirectableBuild(command)
  const call =
    parsed?.directory === undefined
      ? `pass command: ${JSON.stringify(parsed?.command ?? core)} to run this exact one`
      : `pass directory: ${JSON.stringify(parsed.directory)} and command: ${JSON.stringify(parsed.command)} — it builds there, so you do not need the \`cd\``
  return [
    `Blocked: \`${cmd}\` builds the project — call ${BUILD_TOOL_NAME} instead.`,
    `With no arguments it runs the build it detects here; ${call}.`,
    ...(core === cmd
      ? []
      : [
          `The output filter is dropped on purpose — ${BUILD_TOOL_NAME} already trims to what matters, and a Bash result carries stderr without \`2>&1\`.`,
        ]),
    `If you specifically need the raw build log, re-send this exact Bash command and it will run.`,
  ].join(' ')
}
