import { feature } from 'bun:bundle'

// json-structural only earns a strategy slot when it meaningfully shrinks the
// payload. Without this floor a wrapper-dominated object (a giant non-array
// field beside a small array) renders ~as large as the input and would ship as
// a near-zero "compression"; the original passes through instead.
const JSON_MIN_SAVINGS = 0.15
export function jsonSavesEnough(render: string, original: string): boolean {
  return render.length <= original.length * (1 - JSON_MIN_SAVINGS)
}

// Same floor for the code-outline strategy: an outline that barely shrinks the
// source (a file of one-liners) ships as a near-zero "compression", so it falls
// through to head/tail instead.
const CODE_MIN_SAVINGS = 0.15
export function codeSavesEnough(render: string, original: string): boolean {
  return render.length <= original.length * (1 - CODE_MIN_SAVINGS)
}

// A blob needs at least this many symbols to be worth outlining; below it the
// outline saves nothing and head/tail is just as good.
export const CODE_OUTLINE_MIN_SYMBOLS = 3

// Per-tool thresholds (chars). Kept local to avoid importing toolLimits cycles.
export const BASH_SUMMARIZE_THRESHOLD = 8_000
export const GREP_SUMMARIZE_THRESHOLD = 6_000
/**
 * Grep has a second, lower gate. Between the floor and the threshold a summary
 * ships ONLY if it elides no match line — clamped context and collapsed
 * duplicates are fine, a `+N more matches` counter is not.
 *
 * Measured over the recorded transcripts before choosing this shape: dropping
 * the threshold to 3,000 outright would newly summarize 552 results and save
 * 908,145 chars, but HALF of them (275) would trade a match locator for a
 * counter, against a third in the band already summarized. Small results skew
 * match-dense — a body that clears 3,000 without context is a listing where
 * every line is a distinct hit — so the naive cut buys its extra bytes with
 * exactly the information a search is for. Restricted to the lossless ones it
 * is 404,528 chars over 277 results and nothing a match line said is lost.
 */
export const GREP_SUMMARIZE_FLOOR = 3_000
export const WEBFETCH_SUMMARIZE_THRESHOLD = 12_000
export const GLOB_SUMMARIZE_THRESHOLD = 3_000
export const AGENT_SUMMARIZE_THRESHOLD = 8_000
export const MCP_SUMMARIZE_THRESHOLD = 8_000

/**
 * Gate for the JSON/array structural-compression strategy (roadmap #1/#2).
 * Mirrors `autoOutlineOnElisionEnabled` (FileReadTool.ts): the env override is
 * mandatory because the test-preload (src/stubs/test-preload.ts) stubs every
 * `feature()` call to false, so tests reach the ON path only via the env var.
 * Production folds `feature('TOOL_RESULT_JSON_COMPRESSION')` at build time.
 */
export function isToolResultJsonCompressionEnabled(): boolean {
  if (process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION === '1') return true
  if (process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION === '0') return false
  if (feature('TOOL_RESULT_JSON_COMPRESSION')) return true
  return false
}

/**
 * Gate for the code-outline strategy (roadmap side-bet). Same shape as the JSON
 * gate above: the env override is mandatory because the test-preload stubs every
 * `feature()` to false, so tests reach the ON path only via the env var.
 * Production folds `feature('TOOL_RESULT_CODE_OUTLINE')` at build time.
 */
export function isToolResultCodeOutlineEnabled(): boolean {
  if (process.env.CLAUDIN_CODE_OUTLINE === '1') return true
  if (process.env.CLAUDIN_CODE_OUTLINE === '0') return false
  if (feature('TOOL_RESULT_CODE_OUTLINE')) return true
  return false
}
