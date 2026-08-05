import type { BuildSystem } from './types.js'

/**
 * The half of build failures no diagnostic parser can read.
 *
 * A compile error has a file and a line, and the parse chain turns it into a
 * diagnostic. Everything else a build can fail on — an unresolvable
 * dependency, a linker error, a plugin that threw, an out-of-memory, a task
 * that exited non-zero — has no position at all. Those failures arrive as a
 * BLOCK of prose somewhere in a log the caller would otherwise have to page
 * through with `| tail -80`, which is the exact behaviour this tool exists to
 * replace.
 *
 * So each build system names where its block starts, and the block is taken
 * from the LAST such start: a build that failed after several retries prints
 * the anchor more than once, and only the final one describes the failure that
 * ended the run.
 */

type BlockPlan = {
  /** Where the block begins. */
  startRe: RegExp
  /** Where it ends, exclusive. Reaching `maxLines` ends it too. */
  stopRe?: RegExp
  maxLines: number
}

const PLANS: Partial<Record<BuildSystem, BlockPlan>> = {
  gradle: {
    startRe: /^FAILURE: Build failed|^\* What went wrong:/,
    // The help footer is boilerplate that is identical for every failure.
    stopRe: /^\* Get more help|^BUILD FAILED in |^\* Try:/,
    maxLines: 20,
  },
  maven: {
    startRe: /^\[ERROR\] Failed to execute goal|^\[ERROR\] BUILD FAILURE/,
    stopRe: /^\[ERROR\] -> \[Help|^\[ERROR\] Re-run Maven/,
    maxLines: 15,
  },
  sbt: {
    startRe: /^\[error\] \(.*\) .*[Ff]ailed|^\[error\] java\.|^\[error\] Nonzero exit/,
    stopRe: /^\[error\] Total time/,
    maxLines: 12,
  },
  cargo: {
    startRe:
      /^error: linking with |^error: failed to run custom build command|^error: could not compile|^error: failed to (?:select|load|get) /,
    maxLines: 15,
  },
  make: {
    startRe: /^\S*make(?:\[\d+\])?: \*\*\* |^\S*make(?:\[\d+\])?: .*No rule to make target/,
    maxLines: 8,
  },
  ninja: { startRe: /^ninja: (?:build stopped|error)/, maxLines: 8 },
  dotnet: { startRe: /\berror (?:MSB|NETSDK)\d+/, maxLines: 10 },
  mix: { startRe: /^\*\* \(Mix\)|^== Compilation error/, maxLines: 12 },
  cmake: { startRe: /^CMake Error/, maxLines: 12 },
  zig: { startRe: /^error: the following build command failed/, maxLines: 8 },
  xcodebuild: { startRe: /^(?:\*\* BUILD FAILED \*\*|xcodebuild: error:)/, maxLines: 12 },
}

/**
 * When the build system is unknown, or known but silent on its own failure,
 * fall back to the lines that name a failure. Anchored to the END of the output
 * because that is where a build reports why it stopped, and capped hard: this
 * is a summary, and an uncapped one would reproduce the log it replaces.
 */
const GENERIC_FAILURE_RE =
  /\b(?:error|fatal|failed|failure|not found|no such file|could not|cannot|unable to)\b/i
const GENERIC_TAIL_LINES = 60
const GENERIC_MAX_LINES = 10

/** Diagnostics already carry these; repeating them in the block is pure duplication. */
const POSITION_LINE_RE = /:\d+(?::\d+)?[:\s]/

/**
 * A whole-line JSON object, which is machine format bleeding into a block of
 * prose. Real: cargo runs under `--message-format=json` and still prints its
 * human `error: could not compile` summary, with `{"reason":"build-finished"}`
 * on the line after it. Skipped rather than treated as a stop, so a JSON line
 * sandwiched between two prose lines costs the second one nothing.
 */
const MACHINE_LINE_RE = /^\s*[{[].*[}\]]\s*$/

function collect(lines: string[], startIndex: number, plan: BlockPlan): string {
  const block: string[] = []
  for (let i = startIndex; i < lines.length && block.length < plan.maxLines; i++) {
    const line = lines[i]!
    if (i > startIndex && plan.stopRe?.test(line)) break
    if (MACHINE_LINE_RE.test(line)) continue
    block.push(line)
  }
  while (block.length > 0 && block[block.length - 1]!.trim() === '') block.pop()
  return block.join('\n')
}

function genericBlock(lines: string[]): string | undefined {
  const tail = lines.slice(Math.max(0, lines.length - GENERIC_TAIL_LINES))
  const hits = tail.filter(
    line =>
      line.trim() !== '' &&
      GENERIC_FAILURE_RE.test(line) &&
      !POSITION_LINE_RE.test(line) &&
      !MACHINE_LINE_RE.test(line),
  )
  if (hits.length === 0) return undefined
  return hits.slice(-GENERIC_MAX_LINES).join('\n')
}

/**
 * The failure block for this run, or undefined when the output does not explain
 * itself. Only called for a FAILING build: a successful one has nothing to
 * explain, and the anchors would happily match a warning that says "error" in
 * passing.
 */
export function extractFailureBlock(system: BuildSystem, text: string): string | undefined {
  const lines = text.split('\n')
  const plan = PLANS[system]

  if (plan) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (plan.startRe.test(lines[i]!)) {
        const block = collect(lines, i, plan)
        if (block.trim() !== '') return block
      }
    }
  }

  return genericBlock(lines)
}
