/**
 * POSIX BRE → the dialect ripgrep speaks, for the Bash→Grep redirect.
 *
 * `grep` without `-E` is BRE, and the two dialects invert each other on the
 * characters that matter most: `grep 'foo\|bar'` is an alternation while rg
 * reads a literal pipe, and `grep 'foo|bar'` is the exact inverse. The redirect
 * used to stand the whole command down whenever a BRE pattern carried one of
 * them (`BRE_DIVERGENT_RE`), which is safe and, measured on real sessions, the
 * single most common reason a `grep` kept running in the shell — a multi-term
 * `a\|b\|c` is how the model spells "any of these".
 *
 * So translate instead of standing down, under one rule: **produce a pattern
 * that is provably the same search, or produce nothing**. Every construct whose
 * equivalence this function cannot prove returns `null`, and the caller falls
 * back to running the shell command. Not translating costs a round-trip;
 * translating wrong costs a search that answers different lines and says
 * nothing about it.
 *
 * What the translation actually does is swap which side of the backslash the
 * meaning lives on. In BRE the metacharacter is `\(`, `\|`, `\{` and the bare
 * `(`, `|`, `{` are literals; in ERE it is the other way round. Anchors and the
 * repetition star are worse: they are special by POSITION, not by spelling
 * (`^` is an anchor only at the start of the pattern or right after `\(` or
 * `\|`; `a^b` matches a literal caret in grep and NOTHING in rg, a silent
 * divergence). Those are the rules the single pass below tracks.
 *
 * Deliberately NOT translated, each returning `null`:
 *
 *  - back-references (`\1`…`\9`) — rust-regex has none, at any spelling.
 *  - `\<` `\>` `` \` `` `\'` — GNU word/buffer anchors whose rg support depends
 *    on the version, so "the same search" is not something this can promise.
 *  - an alphanumeric escape the engines do not share (`\d`, `\n`) — grep reads
 *    a literal `d`, rg a digit class: same match count, different lines.
 *  - a backslash inside a bracket expression — POSIX makes it an ordinary
 *    character there, so grep reads `[\w]` as the two literals `\` and `w`
 *    where rg reads a word class (and aborts outright on `[\b]`).
 *  - a repetition operator stacked on another (`a**`, `a\{2\}*`) — valid to
 *    grep, a parse error to rg.
 */

/** A character that opens a POSIX class/collating/equivalence inside `[...]`. */
const POSIX_CLASS_OPEN_RE = /^[:=.]$/

/** Escapes ERE gives no meaning to, so they are literal in both dialects. */
const ERE_SHARED_ESCAPE_RE = /^[wWsSbB]$/

const ALNUM_RE = /^[A-Za-z0-9]$/

/** The GNU anchors with no version-independent rg spelling. */
const GNU_ANCHOR_ESCAPE_RE = /^[<>`']$/

/** In BRE these are ordinary characters; in ERE each is a metacharacter. */
const LITERAL_IN_BRE_RE = /^[|(){}+?]$/

/** `{2}`, `{2,}`, `{2,5}` — the whole interval body, without its braces. */
const INTERVAL_BODY_RE = /^\d+(,\d*)?$/

/**
 * Index of the `]` that closes the bracket expression opening at `start`, or
 * -1 when it never closes. Tracks the POSIX corner cases: a leading `^`
 * negates, a `]` in first position is a literal member, and `[:alpha:]`-style
 * classes nest their own `[:…:]` pair — closing at that inner `]` would desync
 * the scan and split a class in half.
 */
function bracketEnd(pattern: string, start: number): number {
  let j = start + 1
  if (pattern[j] === '^') j++
  if (pattern[j] === ']') j++
  while (j < pattern.length) {
    const ch = pattern[j]!
    if (ch === '[' && POSIX_CLASS_OPEN_RE.test(pattern[j + 1] ?? '')) {
      const closer = pattern.indexOf(pattern[j + 1]! + ']', j + 2)
      if (closer !== -1) {
        j = closer + 2
        continue
      }
    }
    if (ch === ']') return j
    j++
  }
  return -1
}

/**
 * Returns the ERE-equivalent pattern, or null when equivalence cannot be
 * proven. The input is the pattern as `grep` received it — already through
 * shell quoting, so the backslashes here are the ones the regex engine sees.
 */
export function breToEre(pattern: string): string | null {
  const out: string[] = []
  /** No atom precedes this position, so a repetition operator is a literal. */
  let atomExpected = true
  /** `^` is an anchor here: pattern start, or right after `\(` or `\|`. */
  let anchorAllowed = true
  /** The previous emission was `*`, `+`, `?` or an interval. */
  let afterRepetition = false
  let groupDepth = 0

  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!

    if (ch === '[') {
      const end = bracketEnd(pattern, i)
      // An unclosed `[` aborts grep ("Unmatched [") and rg alike, so the
      // command never searched anything to reproduce.
      if (end === -1) return null
      const span = pattern.slice(i, end + 1)
      if (span.includes('\\')) return null
      out.push(span)
      i = end + 1
      atomExpected = false
      anchorAllowed = false
      afterRepetition = false
      continue
    }

    if (ch === '\\') {
      const next = pattern[i + 1]
      if (next === undefined) return null // a trailing backslash is undefined
      if (next === '|') {
        out.push('|')
        atomExpected = true
        anchorAllowed = true
        afterRepetition = false
      } else if (next === '(') {
        out.push('(')
        groupDepth++
        atomExpected = true
        anchorAllowed = true
        afterRepetition = false
      } else if (next === ')') {
        if (groupDepth === 0) return null
        groupDepth--
        out.push(')')
        atomExpected = false
        anchorAllowed = false
        afterRepetition = false
      } else if (next === '{') {
        const close = pattern.indexOf('\\}', i + 2)
        if (close === -1) return null
        const body = pattern.slice(i + 2, close)
        if (!INTERVAL_BODY_RE.test(body)) return null
        if (atomExpected || afterRepetition) return null
        out.push(`{${body}}`)
        i = close + 2
        anchorAllowed = false
        afterRepetition = true
        continue
      } else if (next === '}') {
        return null // a `\}` with no `\{` is undefined in BRE
      } else if (next === '+' || next === '?') {
        if (atomExpected || afterRepetition) return null
        out.push(next)
        anchorAllowed = false
        afterRepetition = true
        i += 2
        continue
      } else if (GNU_ANCHOR_ESCAPE_RE.test(next)) {
        return null
      } else if (ALNUM_RE.test(next) && !ERE_SHARED_ESCAPE_RE.test(next)) {
        return null // \1…\9 back-references and \d-style class escapes
      } else {
        // A shared class escape (\w, \b) or an escaped punctuation mark, which
        // means the literal character in both dialects.
        out.push('\\' + next)
        atomExpected = false
        anchorAllowed = false
        afterRepetition = false
      }
      i += 2
      continue
    }

    if (ch === '^') {
      if (anchorAllowed) {
        out.push('^')
        // A `*` right after the anchor is still a literal to grep, so the
        // position keeps expecting an atom — but a SECOND `^` is a literal.
        anchorAllowed = false
      } else {
        out.push('\\^')
        atomExpected = false
        afterRepetition = false
      }
      i++
      continue
    }

    if (ch === '$') {
      // `$` is an anchor at the end of the pattern and before `\)` or `\|`;
      // anywhere else grep matches a literal dollar while rg anchors and
      // answers nothing.
      const rest = pattern.slice(i + 1)
      if (rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|')) {
        out.push('$')
      } else {
        out.push('\\$')
      }
      atomExpected = false
      anchorAllowed = false
      afterRepetition = false
      i++
      continue
    }

    if (ch === '*') {
      if (atomExpected) {
        out.push('\\*')
        afterRepetition = false
      } else {
        if (afterRepetition) return null
        out.push('*')
        afterRepetition = true
      }
      atomExpected = false
      anchorAllowed = false
      i++
      continue
    }

    if (LITERAL_IN_BRE_RE.test(ch)) {
      out.push('\\' + ch)
    } else {
      out.push(ch)
    }
    atomExpected = false
    anchorAllowed = false
    afterRepetition = false
    i++
  }

  // An unclosed `\(` is a grep error, so again there is no search to reproduce.
  if (groupDepth !== 0) return null
  return out.join('')
}
