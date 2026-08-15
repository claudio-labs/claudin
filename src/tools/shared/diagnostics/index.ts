import { parseGnuStyle } from 'src/tools/shared/diagnostics/gnuStyle.js'
import { scrapeCounts } from 'src/tools/shared/diagnostics/heuristic.js'
import { parseMsvcStyle } from 'src/tools/shared/diagnostics/msvcStyle.js'
import type { DiagnosticParser, ParseInput, RawDiagnostic } from 'src/tools/shared/diagnostics/types.js'

/**
 * The shared parse chain, used by both `Typecheck` and `Build`.
 *
 * It takes an ordered PARSER LIST rather than a checker name: the two tools
 * enumerate different toolchains (there is no `Checker` value for `ninja`, and
 * no build system called `pyright`), and a chain keyed on one tool's enum would
 * have to grow a case for the other's. Each tool keeps its own name → parser
 * map and hands the result here.
 *
 * Every chain ends with the two generic position formats. That fall-through is
 * not defensive padding: a compiler invoked through a composed package script
 * or a build wrapper never receives its machine-format flag, so a `cargo` run
 * can legitimately arrive as human text. Trying the generic parsers keeps those
 * runs structured instead of degraded.
 */

export type ParseOutcome = {
  diagnostics: RawDiagnostic[]
  degraded: boolean
  /** Text-scraped lower bound, set only when nothing could be parsed. */
  estimatedErrors?: number
  estimatedWarnings?: number
}

/** Appended to every chain, minus whatever the caller already named. */
export const GENERIC_PARSERS: DiagnosticParser[] = [parseMsvcStyle, parseGnuStyle]

/**
 * Belt and braces for the text parsers, which all match on line shape. Runners
 * ask for NO_COLOR, but a compiler is free to ignore it — deno colours its
 * output whenever FORCE_COLOR is merely PRESENT, whatever its value — and an
 * escape sequence in front of a code turns a matching line into an
 * unrecognised one, which degrades the whole run.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g

export function stripAnsi(input: ParseInput): ParseInput {
  if (!input.stdout.includes('\u001B') && !input.stderr.includes('\u001B')) return input
  return {
    ...input,
    stdout: input.stdout.replace(ANSI_RE, ''),
    stderr: input.stderr.replace(ANSI_RE, ''),
  }
}

/** A parser throwing is a bug in that parser, not a failed run — skip it. */
function runParser(parse: DiagnosticParser, input: ParseInput): RawDiagnostic[] {
  try {
    return parse(input)?.diagnostics ?? []
  } catch {
    return []
  }
}

function dedupeKey(d: RawDiagnostic): string {
  return `${d.file}\u0000${d.line}\u0000${d.column ?? ''}\u0000${d.message}`
}

/**
 * Run the `native` parsers, then the generic ones, and report whether the
 * output could be read at all.
 *
 * The native parsers are MERGED rather than raced, because one toolchain can
 * emit two formats in one run: a Gradle build compiles Kotlin and Java in
 * separate tasks, and taking only the first parser that matched would report
 * the Kotlin errors and silently drop the javac ones. They are safe to merge
 * precisely because they match disjoint line shapes; the identical-diagnostic
 * dedupe below covers the overlap anyway. The GENERIC parsers stay
 * first-wins — `msvcStyle` and `gnuStyle` do read some of the same lines, and
 * merging those would double-count.
 *
 * A clean exit with no recognisable output is the normal shape of a PASSING run
 * (tsc prints nothing at all, a cached build prints one line), so that is not
 * degraded — only a FAILING run we could not read is.
 */
export function parseDiagnostics(native: DiagnosticParser[], rawInput: ParseInput): ParseOutcome {
  const input = stripAnsi(rawInput)

  const merged = new Map<string, RawDiagnostic>()
  for (const parse of native) {
    for (const diagnostic of runParser(parse, input)) {
      const key = dedupeKey(diagnostic)
      if (!merged.has(key)) merged.set(key, diagnostic)
    }
  }
  if (merged.size > 0) return { diagnostics: [...merged.values()], degraded: false }

  for (const parse of GENERIC_PARSERS.filter(p => !native.includes(p))) {
    const diagnostics = runParser(parse, input)
    if (diagnostics.length > 0) return { diagnostics, degraded: false }
  }

  if (input.exitCode === 0) return { diagnostics: [], degraded: false }

  const counts = scrapeCounts(input)
  return {
    diagnostics: [],
    degraded: true,
    estimatedErrors: counts.errors,
    estimatedWarnings: counts.warnings,
  }
}
