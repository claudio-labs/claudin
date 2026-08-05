import type { BuildSystem } from './types.js'

/**
 * Did this build actually rebuild anything?
 *
 * It matters because an incremental build that recompiles nothing prints no
 * warnings and produces no artifact — so reporting it as `✓ 0 errors,
 * 0 warnings` is a claim about a compilation that never happened, and the
 * classic way to read a stale tree as a clean one.
 *
 * Every rule below requires POSITIVE evidence of a no-op. Systems that give
 * none are deliberately absent: `go build` and `dotnet build` print the same
 * thing either way, so for those the honest answer is "we do not know", and the
 * result simply omits the up-to-date line rather than guessing at it.
 */

type NoOpRule = {
  /** Proof that nothing was rebuilt. */
  idleRe: RegExp
  /** Proof that something WAS rebuilt; it wins over `idleRe`. */
  workRe?: RegExp
}

const RULES: Partial<Record<BuildSystem, NoOpRule>> = {
  // "3 actionable tasks: 3 up-to-date" — with any executed task it reads
  // "2 executed, 1 up-to-date", which is a real build.
  gradle: { idleRe: /\d+ up-to-date\b/, workRe: /\d+ executed\b/ },
  cargo: { idleRe: /^\s*Finished\b/m, workRe: /^\s*Compiling\b/m },
  make: { idleRe: /Nothing to be done for|is up to date\b/ },
  ninja: { idleRe: /^ninja: no work to do\.?$/m },
  cmake: { idleRe: /^ninja: no work to do\.?$/m, workRe: /^\[\d+\/\d+\]/m },
  // `mix compile` announces "Compiling N files" and is otherwise silent, so
  // silence IS the evidence here rather than the absence of it.
  mix: { idleRe: /^/, workRe: /Compiling \d+ files?|Generated \w+ app/ },
}

export function isUpToDate(system: BuildSystem, text: string, exitCode: number): boolean {
  if (exitCode !== 0) return false
  const rule = RULES[system]
  if (!rule) return false
  if (rule.workRe?.test(text)) return false
  return rule.idleRe.test(text)
}
