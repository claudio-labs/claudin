import type { Checker, ParseInput, RawDiagnostic } from '../types.js'
import { parseCargoJson } from './cargoJson.js'
import { parseDartMachine } from './dartMachine.js'
import { parseDenoText } from './denoText.js'
import { parseGnuStyle } from './gnuStyle.js'
import { scrapeCounts } from './heuristic.js'
import { parseMsvcStyle } from './msvcStyle.js'
import { parsePhpstanJson, parsePsalmJson } from './phpJson.js'
import { parseMypyJson, parsePyrightJson } from './pythonJson.js'

/**
 * Parse chain. Each checker names its native parser first, then falls through
 * to the two generic position formats before giving up.
 *
 * The fall-through is not defensive padding: a checker invoked through a
 * composed package script never receives the machine-format flag, so a `cargo`
 * run can legitimately arrive as human text. Trying the generic parsers keeps
 * those runs structured instead of degraded.
 */

export type ParseOutcome = {
  diagnostics: RawDiagnostic[]
  degraded: boolean
  /** Text-scraped lower bound, set only when nothing could be parsed. */
  estimatedErrors?: number
  estimatedWarnings?: number
}

type Parser = (input: ParseInput) => { diagnostics: RawDiagnostic[] } | null

const NATIVE_PARSERS: Partial<Record<Checker, Parser>> = {
  cargo: parseCargoJson,
  pyright: parsePyrightJson,
  mypy: parseMypyJson,
  dart: parseDartMachine,
  phpstan: parsePhpstanJson,
  psalm: parsePsalmJson,
  deno: parseDenoText,
  tsc: parseMsvcStyle,
  dotnet: parseMsvcStyle,
  go: parseGnuStyle,
  maven: parseGnuStyle,
  gradle: parseGnuStyle,
}

const GENERIC_PARSERS: Parser[] = [parseMsvcStyle, parseGnuStyle]

/**
 * Belt and braces for the text parsers, which all match on line shape. The
 * runner asks for NO_COLOR, but a checker is free to ignore it — deno colours
 * its output whenever FORCE_COLOR is merely PRESENT, whatever its value — and
 * an escape sequence in front of a code turns a matching line into an
 * unrecognised one, which degrades the whole run.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g

function stripAnsi(input: ParseInput): ParseInput {
  if (!input.stdout.includes('\u001B') && !input.stderr.includes('\u001B')) return input
  return {
    ...input,
    stdout: input.stdout.replace(ANSI_RE, ''),
    stderr: input.stderr.replace(ANSI_RE, ''),
  }
}

export function parseCheckerOutput(checker: Checker, rawInput: ParseInput): ParseOutcome {
  const input = stripAnsi(rawInput)
  const candidates: Parser[] = []
  const native = NATIVE_PARSERS[checker]
  if (native) candidates.push(native)
  candidates.push(...GENERIC_PARSERS.filter(p => p !== native))

  for (const parse of candidates) {
    try {
      const result = parse(input)
      if (result && result.diagnostics.length > 0) {
        return { diagnostics: result.diagnostics, degraded: false }
      }
    } catch {
      // A parser throwing is a bug in that parser, not a failed check — skip it.
    }
  }

  // Nothing matched. A clean exit with no recognisable output is the normal
  // shape of a PASSING check (tsc prints nothing at all), so that is not
  // degraded — only a failing run we could not read is.
  if (input.exitCode === 0) return { diagnostics: [], degraded: false }

  const counts = scrapeCounts(input)
  return {
    diagnostics: [],
    degraded: true,
    estimatedErrors: counts.errors,
    estimatedWarnings: counts.warnings,
  }
}
