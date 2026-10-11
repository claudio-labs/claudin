/**
 * Compile WaitFor's `until`, accepting a leading inline flag group.
 *
 * `(?s)…` is how PCRE and Python turn on dot-all, and the model writes it that
 * way to match CI rows spread over several lines. JavaScript has no global
 * inline group — only the scoped `(?s:…)` — so `new RegExp` threw, and the
 * 2026-10-05..11 census saw three waits refused for it. A leading group of
 * flags JavaScript does have becomes those flags; anything else (`(?x)`) is
 * left for `new RegExp` to reject as before.
 */

const LEADING_FLAGS_RE = /^\(\?([imsu]+)\)/

/** @throws SyntaxError when the pattern is not a valid regex. */
export function compileUntil(source: string): RegExp {
  const leading = LEADING_FLAGS_RE.exec(source)
  if (!leading) return new RegExp(source)
  const flags = [...new Set(leading[1])].join('')
  return new RegExp(source.slice(leading[0].length), flags)
}
