import {
  parseDiagnostics,
  type ParseOutcome,
} from 'src/tools/shared/diagnostics/index.js'
import { parseCargoJson } from 'src/tools/shared/diagnostics/cargoJson.js'
import { parseDartMachine } from 'src/tools/shared/diagnostics/dartMachine.js'
import { parseDenoText } from 'src/tools/shared/diagnostics/denoText.js'
import { parseGnuStyle } from 'src/tools/shared/diagnostics/gnuStyle.js'
import { parseMsvcStyle } from 'src/tools/shared/diagnostics/msvcStyle.js'
import { parsePhpstanJson, parsePsalmJson } from 'src/tools/shared/diagnostics/phpJson.js'
import { parseMypyJson, parsePyrightJson } from 'src/tools/shared/diagnostics/pythonJson.js'
import type { DiagnosticParser, ParseInput } from 'src/tools/shared/diagnostics/types.js'
import type { Checker } from 'src/tools/TypecheckTool/types.js'

/**
 * This tool's checker → native-parser map. The chain itself, the ANSI strip and
 * the degraded fallback live in `shared/diagnostics/` because `Build` needs the
 * same machinery over a different set of toolchains.
 */
const NATIVE_PARSERS: Partial<Record<Checker, DiagnosticParser>> = {
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

export type { ParseOutcome }

export function parseCheckerOutput(checker: Checker, input: ParseInput): ParseOutcome {
  const native = NATIVE_PARSERS[checker]
  return parseDiagnostics(native ? [native] : [], input)
}
