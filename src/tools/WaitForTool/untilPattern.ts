/**
 * How a wait reads its `until` regex — WaitFor's, and `scripts/dev/tui-probe.ts
 * wait --until`, so the two cannot drift.
 *
 * `^` and `$` match at line breaks. The model writes `^exit \d+` for the line a
 * script echoes under a test summary, the way grep reads it; with JavaScript's
 * whole-output anchors, 12 of the 124 waits that timed out between 2026-09-01
 * and 11-26 had that line in their last output, three of them after 1,200 to
 * 1,800 s on suites that took about seven minutes. Two shapes keep the
 * whole-output reading, because a line would end them early:
 *
 * - a lookaround anywhere — `^(?![\s\S]*pending)…` and its tempered form
 *   `^(?:(?!pending)[\s\S])*$` ask that nothing ANYWHERE is still pending (9
 *   CI waits in the same window, all matched);
 * - a test for an empty output, `^$` or `^\s*$`, alone or as one alternative
 *   (`^\s*$|^No pull requests`), which a blank line would pass.
 *
 * A pattern is matched against the output as polled and without its trailing
 * newlines, and either one matching is a match: a whole-output `…done$` sees
 * the end past a final `\n`, and `READY\n` still sees the `\n` it names.
 *
 * `(?s)…` is how PCRE and Python turn on dot-all, and the model writes it that
 * way to match CI rows spread over several lines. JavaScript has no global
 * inline group — only the scoped `(?s:…)` — so `new RegExp` threw, and the
 * 2026-10-05..11 census saw three waits refused for it. A leading group of
 * `i`, `m` and `s` becomes those flags; anything else is left for `new RegExp`
 * to reject as before. `u` stays out: in JavaScript it is a stricter mode that
 * rejects escapes like `\-`, not the no-op it is in Python.
 */
const LEADING_FLAGS_RE = /^\(\?([ims]+)\)/
// `(?=`, `(?!`, `(?<=` or `(?<!`, not after a backslash (`\(` is a literal paren).
const LOOKAROUND_RE = /(?<!\\)\(\?<?[=!]/
// `^$` or `^\s*$` as the whole pattern or as one alternative of a group.
const EMPTY_OUTPUT_RE = /(?:^|\||\((?:\?:)?)\^(?:\\s\*)?\$(?=$|\||\))/
const TRAILING_NEWLINES_RE = /[\r\n]+$/

/** @throws SyntaxError when `source` is not a valid regex. */
export function compileUntil(source: string): RegExp {
  const leading = LEADING_FLAGS_RE.exec(source)
  const body = leading ? source.slice(leading[0].length) : source
  const flags = leading?.[1] ?? ''
  const wholeOutput = LOOKAROUND_RE.test(body) || EMPTY_OUTPUT_RE.test(body)
  return new RegExp(body, wholeOutput || flags.includes('m') ? flags : `${flags}m`)
}

/** Whether one polled output satisfies a compiled `until`. */
export function untilMatches(until: RegExp, output: string): boolean {
  return until.test(output) || until.test(output.replace(TRAILING_NEWLINES_RE, ''))
}
