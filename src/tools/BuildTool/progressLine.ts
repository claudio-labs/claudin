import type { BuildSystem } from './types.js'

/**
 * What the build is doing RIGHT NOW, reduced to one line.
 *
 * Same thesis as the rest of the tool applied to the live view: a raw tail is
 * the noise the tool exists to hide, so this picks the one line that names the
 * phase and drops the rest. It runs against a ~4KB tail of the output file
 * every second, so it must stay cheap and must never throw.
 *
 * Ordering matters. A step counter beats a target name, and a target name beats
 * the last line, because the counter is the only form that tells the reader how
 * much is left. When a toolchain offers none of them the generic fallback is
 * the last non-empty line — still better than a blank screen, and it is what
 * `make` gives us since it just echoes each recipe.
 *
 * Nothing here is a parser: a missed match costs a slightly worse label for one
 * second, never a wrong result. The build's real output is parsed once, whole,
 * at the end.
 */

type ProgressRule = {
  /** Whole-line patterns, tried in order; the first one that matches wins. */
  patterns: RegExp[]
}

/**
 * Per-system extraction. `m` on every pattern because the input is a tail of
 * many lines; the LAST match is the one taken (see `lastMatch`), since the tail
 * ends at the newest output.
 */
const RULES: Partial<Record<BuildSystem, ProgressRule>> = {
  // "[312/847] Building CXX object src/foo.o" — the best case any toolchain
  // gives: a real ratio, so the reader knows how far along the build is.
  ninja: { patterns: [/^\[\d+\/\d+\].*$/gm] },
  cmake: { patterns: [/^\[\s*\d+%\]\s.*$/gm, /^\[\d+\/\d+\].*$/gm] },
  // Verified live against `cargo build --message-format=json`: the human lines
  // (Compiling/Updating/Finished) are interleaved with the JSON on the same
  // stream, so they are present in the tail despite the machine format.
  cargo: {
    patterns: [/^\s*(Compiling|Updating|Downloading|Locking|Finished)\b.*$/gm],
  },
  // "> Task :app:compileKotlin"
  gradle: { patterns: [/^>\s*Task\s.*$/gm, /^>\s*\w.*$/gm] },
  maven: { patterns: [/^\[INFO\]\s*(Building|Compiling)\s.*$/gm] },
  sbt: { patterns: [/^\[info\]\s*(compiling|done compiling).*$/gim] },
  dotnet: { patterns: [/^\s*\w[\w.]*\s*->\s*.*$/gm] },
  swift: { patterns: [/^\s*(Compiling|Building|Linking)\b.*$/gm] },
  mix: { patterns: [/^\s*(Compiling|Generated)\b.*$/gm] },
  flutter: { patterns: [/^\s*(Building|Running)\b.*$/gm] },
}

/** The last match, because the tail's newest line is at the end. */
function lastMatch(text: string, pattern: RegExp): string | null {
  // A fresh regex per call: the `g` flag makes `lastIndex` stateful, and a
  // module-level literal shared across calls would skip matches.
  const re = new RegExp(pattern.source, pattern.flags)
  let found: RegExpExecArray | null = null
  let hit: RegExpExecArray | null
  while ((hit = re.exec(text)) !== null) {
    found = hit
    // A zero-width match would spin forever; step past it.
    if (hit.index === re.lastIndex) re.lastIndex++
  }
  return found ? found[0].trim() : null
}

/**
 * The last line that has anything on it.
 *
 * Lives here rather than in `run.ts` so the dependency runs one way: `run.ts`
 * imports this module for the live label, and would import it back for the
 * stall report's `lastLine` if this stayed there.
 */
export function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line !== '') return line
  }
  return undefined
}

/** Collapse the runs of whitespace a build tool uses to align its columns. */
function tidy(line: string, maxChars: number): string {
  const collapsed = line.replace(/\s+/g, ' ').trim()
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed
}

const MAX_LABEL_CHARS = 90

export function progressLabel(system: BuildSystem, tail: string): string | null {
  if (!tail.trim()) return null
  const rule = RULES[system]
  for (const pattern of rule?.patterns ?? []) {
    const hit = lastMatch(tail, pattern)
    if (hit) return tidy(hit, MAX_LABEL_CHARS)
  }
  const fallback = lastNonEmptyLine(tail)
  return fallback ? tidy(fallback, MAX_LABEL_CHARS) : null
}
