// Per-family string/comment maskers.
//
// One masker per language family whose lexical rules differ enough from the
// C-like default that `maskCLike` cannot be parameterized into them. Maskers
// used by exactly one scanner (ruby, lua, sql, css, html, xml, graphql,
// terraform) live with that scanner in ../langs/ instead.

import {
  maskCLike,
  maskInterpolationAt,
  maskLiteral,
  RE_IDENT_CHAR,
  RE_IDENT_START,
  MASK_OPTS_PLAIN,
  type Interpolation,
  type MaskCtx,
} from 'src/tools/shared/codeOutline/mask/core.js'

export function maskPython(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }

  while (i < n) {
    const c = source[i]
    if (c === '#') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '"' || c === "'") {
      const triple = source[i + 1] === c && source[i + 2] === c
      i = maskLiteral(ctx, i, {
        terminator: triple ? c.repeat(3) : c,
        escape: '\\',
        // A single-quoted literal cannot span lines; an unterminated one ends
        // at the newline rather than swallowing the rest of the file.
        stopAtNewline: !triple,
        interp,
      })
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Rust-aware masking. Differs from maskCLike in three ways: block comments
 * nest, raw strings (`r"..."`, `r#"..."#`, `br#"..."#`) close on the matching
 * hash count with no escapes, and a lone `'` is a lifetime (`'a`) — only a
 * real char literal (`'x'`, `'\n'`) is masked. Multi-code-unit char literals
 * (`'🦀'`) fall through the lifetime path; fail-open covers that edge.
 */
export function maskRust(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const identChar = (k: number) => k >= 0 && RE_IDENT_CHAR.test(source[k]!)
  const ctx: MaskCtx = { source, n, blank }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      let depth = 1
      blank(i++)
      blank(i++)
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++
          blank(i++)
          blank(i++)
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--
          blank(i++)
          blank(i++)
        } else {
          blank(i++)
        }
      }
      continue
    }
    // Raw (byte) strings — only when r/br starts a token, not ends an ident.
    const rawStart =
      !identChar(i - 1) &&
      ((c === 'r' && (c2 === '"' || c2 === '#')) ||
        (c === 'b' && c2 === 'r' && (source[i + 2] === '"' || source[i + 2] === '#')))
    if (rawStart) {
      let j = i + (c === 'b' ? 2 : 1)
      let hashes = 0
      while (j < n && source[j] === '#') {
        hashes++
        j++
      }
      if (source[j] === '"') {
        while (i <= j) blank(i++) // prefix, hashes, opening quote
        const closer = '"' + '#'.repeat(hashes)
        while (i < n && !source.startsWith(closer, i)) blank(i++)
        for (let k = 0; k < closer.length && i < n; k++) blank(i++)
        continue
      }
      // `r#ident` raw identifier — not a string; fall through.
    }
    if (c === '"') {
      i = maskLiteral(ctx, i, { terminator: '"', escape: '\\', interp })
      continue
    }
    if (c === "'") {
      if (c2 === '\\') {
        // Escaped char literal — blank through the closing quote (bounded:
        // the longest form is '\u{10FFFF}').
        blank(i++)
        let steps = 0
        while (i < n && source[i] !== "'" && steps < 12) {
          blank(i++)
          steps++
        }
        if (i < n && source[i] === "'") blank(i++)
        continue
      }
      if (c2 !== undefined && source[i + 2] === "'") {
        blank(i++)
        blank(i++)
        blank(i++)
        continue
      }
      // Lifetime or loop label — real code, leave it visible.
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * PHP masking. Handles `//` and `#` line comments (but keeps `#[` attribute
 * markers visible), `/* *​/` block comments, single/double strings, and
 * heredoc/nowdoc (`<<<EOT … EOT;`, `<<<'EOT'`, `<<<"EOT"`). Best-effort:
 * a malformed heredoc degrades to fail-open at the scanner level.
 */
export function maskPhp(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '/') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    // `#` line comment — but `#[` opens a PHP 8 attribute, which we keep.
    if (c === '#' && c2 !== '[') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (c === '<' && c2 === '<' && source[i + 2] === '<') {
      let j = i + 3
      while (j < n && source[j] === ' ') j++
      let quote = ''
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j]!
        j++
      }
      let id = ''
      if (j < n && RE_IDENT_START.test(source[j]!)) {
        while (j < n && RE_IDENT_CHAR.test(source[j]!)) {
          id += source[j]
          j++
        }
      }
      if (id) {
        if (quote && source[j] === quote) j++
        while (i < j) blank(i++)
        while (i < n && source[i] !== '\n') blank(i++)
        if (i < n) i++ // keep the newline
        while (i < n) {
          const lineStart = i
          let k = i
          while (k < n && source[k] !== '\n') k++
          let p = lineStart
          while (p < k && (source[p] === ' ' || source[p] === '\t')) p++
          const closes =
            source.startsWith(id, p) &&
            !RE_IDENT_CHAR.test(source[p + id.length] ?? '')
          for (let q = lineStart; q < k; q++) blank(q)
          i = k
          if (closes) break
          if (i < n) i++
        }
        continue
      }
    }
    if (c === '"' || c === "'") {
      i = maskLiteral(ctx, i, { terminator: c, escape: '\\', interp })
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Bash masking. Handles `#` comments (only when `#` starts a word, so
 * `${#arr}` / `$#` survive), single/double strings, and heredocs
 * (`<<WORD`, `<<-WORD`, `<<'WORD'`). Only `{`/`}` matter to the scanner;
 * `${…}` stays balanced and `if/fi`, `case/esac` contribute no braces.
 */
export function maskBash(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }
  const commentBoundary = (prev: string) =>
    prev === '\n' ||
    prev === ' ' ||
    prev === '\t' ||
    prev === ';' ||
    prev === '&' ||
    prev === '|' ||
    prev === '('
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '#' && commentBoundary(i > 0 ? source[i - 1]! : '\n')) {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    // Heredoc — `<<WORD` / `<<-WORD` / `<<"WORD"` / `<<'WORD'`. Excludes the
    // `<<<` here-string and the `<< N` bit-shift (label must start alpha/_).
    if (c === '<' && c2 === '<' && source[i + 2] !== '<') {
      let j = i + 2
      if (source[j] === '-') j++
      while (j < n && source[j] === ' ') j++
      let quote = ''
      if (source[j] === '"' || source[j] === "'") {
        quote = source[j]!
        j++
      }
      let id = ''
      if (j < n && RE_IDENT_START.test(source[j]!)) {
        while (j < n && RE_IDENT_CHAR.test(source[j]!)) {
          id += source[j]
          j++
        }
      }
      if (id) {
        if (quote && source[j] === quote) j++
        // Blank from `<<` to end of the opening line.
        while (i < n && source[i] !== '\n') blank(i++)
        if (i < n) i++
        while (i < n) {
          const lineStart = i
          let k = i
          while (k < n && source[k] !== '\n') k++
          let p = lineStart
          while (p < k && (source[p] === ' ' || source[p] === '\t')) p++
          const closes =
            source.startsWith(id, p) &&
            !RE_IDENT_CHAR.test(source[p + id.length] ?? '')
          for (let q = lineStart; q < k; q++) blank(q)
          i = k
          if (closes) break
          if (i < n) i++
        }
        continue
      }
    }
    if (c === "'") {
      blank(i++)
      while (i < n && source[i] !== "'") blank(i++)
      if (i < n) blank(i++)
      continue
    }
    if (c === '"') {
      i = maskLiteral(ctx, i, { terminator: '"', escape: '\\', interp })
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Elixir masking. `#` line comments, `"…"` / `'…'` literals and `"""` /
 * `'''` heredocs, all of which interpolate with `#{…}`.
 *
 * Mask-only: there is no Elixir symbol scanner, so a rename site here carries
 * no enclosing symbol. Deliberately does NOT reuse `maskRuby` — Ruby's heredoc
 * rule reads Elixir's `<<"tag">>` binary literal as a heredoc opener and would
 * mask the rest of the file.
 */
export function maskElixir(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }
  while (i < n) {
    const c = source[i]!
    if (c === '#' && source[i + 1] !== '{') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '"' || c === "'") {
      const triple = source[i + 1] === c && source[i + 2] === c
      i = maskLiteral(ctx, i, {
        terminator: triple ? c.repeat(3) : c,
        escape: '\\',
        stopAtNewline: !triple,
        interp,
      })
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * PowerShell masking. `#` line comments, `<# … #>` blocks, `'…'` (literal,
 * `''` escapes the quote) and `"…"` (expanding, backtick escapes), plus the
 * `@"…"@` / `@'…'@` here-strings.
 *
 * Mask-only, like Elixir: sites are exact, enclosing symbols are not resolved.
 */
export function maskPowerShell(source: string, interp?: Interpolation | null): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const ctx: MaskCtx = { source, n, blank }
  while (i < n) {
    const c = source[i]!
    const c2 = source[i + 1]
    if (c === '<' && c2 === '#') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '#' && source[i + 1] === '>')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    // Here-string: `@"` on its own to end of line, closed by `"@` at the start
    // of a later line.
    if (c === '@' && (c2 === '"' || c2 === "'")) {
      const quote = c2
      const closer = `${quote}@`
      blank(i++)
      blank(i++)
      while (i < n) {
        if (source[i] === '\n' && source.startsWith(closer, i + 1)) {
          i++
          blank(i++)
          blank(i++)
          break
        }
        if (quote === '"' && interp) {
          const next = maskInterpolationAt(ctx, i, interp)
          if (next > i) {
            i = next
            continue
          }
        }
        blank(i++)
      }
      continue
    }
    if (c === '"' || c === "'") {
      i = maskLiteral(ctx, i, {
        terminator: c,
        // Backtick is PowerShell's escape character; `\` is literal.
        escape: c === '"' ? '`' : null,
        doubledTerminatorIsEscape: true,
        stopAtNewline: true,
        interp: c === '"' ? interp : null,
      })
      continue
    }
    i++
  }
  return out.join('')
}
