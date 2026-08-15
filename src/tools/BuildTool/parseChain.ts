import { parseBunBuild } from 'src/tools/shared/diagnostics/bunBuild.js'
import { parseCargoJson } from 'src/tools/shared/diagnostics/cargoJson.js'
import { parseEsbuild } from 'src/tools/shared/diagnostics/esbuild.js'
import { parseGnuStyle } from 'src/tools/shared/diagnostics/gnuStyle.js'
import { parseKotlinc } from 'src/tools/shared/diagnostics/kotlinc.js'
import { parseMixCompile } from 'src/tools/shared/diagnostics/mixCompile.js'
import { parseMsvcStyle } from 'src/tools/shared/diagnostics/msvcStyle.js'
import { parseSbtBracket } from 'src/tools/shared/diagnostics/sbtBracket.js'
import type { DiagnosticParser } from 'src/tools/shared/diagnostics/types.js'
import type { BuildSystem } from 'src/tools/BuildTool/types.js'

/**
 * This tool's build-system → native-parser map. The chain itself, the ANSI
 * strip and the degraded fallback live in `shared/diagnostics/`, which
 * `Typecheck` drives from its own map.
 *
 * Several systems name MORE than one parser, which is the reason the shared
 * chain merges native results instead of racing them: one Gradle run compiles
 * Kotlin and Java in separate tasks and emits both formats, and taking only the
 * first parser that matched would silently drop half the failures.
 */
const NATIVE_PARSERS: Partial<Record<BuildSystem, DiagnosticParser[]>> = {
  cargo: [parseCargoJson, parseGnuStyle],
  gradle: [parseKotlinc, parseGnuStyle],
  maven: [parseGnuStyle],
  sbt: [parseSbtBracket],
  mill: [parseSbtBracket],
  dotnet: [parseMsvcStyle],
  go: [parseGnuStyle],
  cmake: [parseGnuStyle],
  make: [parseGnuStyle],
  ninja: [parseGnuStyle],
  swift: [parseGnuStyle],
  xcodebuild: [parseGnuStyle],
  zig: [parseGnuStyle],
  mix: [parseMixCompile],
  rebar3: [parseMixCompile, parseGnuStyle],
  node: [parseEsbuild, parseBunBuild, parseMsvcStyle],
  flutter: [parseGnuStyle],
  dart: [parseGnuStyle],
}

export function parsersFor(system: BuildSystem): DiagnosticParser[] {
  return NATIVE_PARSERS[system] ?? []
}
