/**
 * Heredoc-in-substitution scanning: the early-allow check used by
 * validateSafeCommandSubstitution, and the stripper the pre-split gate uses.
 *
 * Both replicate bash's line-based heredoc-closing behavior rather than using
 * a lazy regex, because `[\s\S]*?` can skip past the first closing delimiter
 * and hide injected commands between two delimiters.
 *
 * NOTE: isSafeHeredoc calls back into bashCommandIsSafe_DEPRECATED, so this
 * module and ./dispatch.js form an import cycle. It resolves because both are
 * hoisted function declarations invoked at call time, never at module init.
 */

import { HEREDOC_IN_SUBSTITUTION } from 'src/tools/BashTool/bashSecurity/context.js'
import { bashCommandIsSafe_DEPRECATED } from 'src/tools/BashTool/bashSecurity/dispatch.js'

/**
 * Checks if a command is a "safe" heredoc-in-substitution pattern that can
 * bypass the generic $() validator.
 *
 * This is an EARLY-ALLOW path: returning `true` causes bashCommandIsSafe to
 * return `passthrough`, bypassing ALL subsequent validators. Given this
 * authority, the check must be PROVABLY safe, not "probably safe".
 *
 * The only pattern we allow is:
 *   [prefix] $(cat <<'DELIM'\n
 *   [body lines]\n
 *   DELIM\n
 *   ) [suffix]
 *
 * Where:
 * - The delimiter must be single-quoted ('DELIM') or escaped (\DELIM) so the
 *   body is literal text with no expansion
 * - The closing delimiter must be on a line BY ITSELF (or with only trailing
 *   whitespace + `)` for the $(cat <<'EOF'\n...\nEOF)` inline form)
 * - The closing delimiter must be the FIRST such line — matching bash's
 *   behavior exactly (no skipping past early delimiters to find EOF))
 * - There must be non-whitespace text BEFORE the $( (i.e., the substitution
 *   is used in argument position, not as a command name). Otherwise the
 *   heredoc body becomes an arbitrary command name with [suffix] as args.
 * - The remaining text (with the heredoc stripped) must pass all validators
 *
 * This implementation uses LINE-BASED matching, not regex [\s\S]*?, to
 * precisely replicate bash's heredoc-closing behavior.
 */
export function isSafeHeredoc(command: string): boolean {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return false

  // SECURITY: Use [ \t] (not \s) between << and the delimiter. \s matches
  // newlines, but bash requires the delimiter word on the same line as <<.
  // Matching across newlines could accept malformed syntax that bash rejects.
  // Handle quote variations: 'EOF', ''EOF'' (splitCommand may mangle quotes).
  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let match
  type HeredocMatch = {
    start: number
    operatorEnd: number
    delimiter: string
    isDash: boolean
  }
  const safeHeredocs: HeredocMatch[] = []

  while ((match = heredocPattern.exec(command)) !== null) {
    const delimiter = match[2] || match[3]
    if (delimiter) {
      safeHeredocs.push({
        start: match.index,
        operatorEnd: match.index + match[0].length,
        delimiter,
        isDash: match[1] === '-',
      })
    }
  }

  // If no safe heredoc patterns found, it's not safe
  if (safeHeredocs.length === 0) return false

  // SECURITY: For each heredoc, find the closing delimiter using LINE-BASED
  // matching that exactly replicates bash's behavior. Bash closes a heredoc
  // at the FIRST line that exactly matches the delimiter. Any subsequent
  // occurrence of the delimiter is just content (or a new command). Regex
  // [\s\S]*? can skip past the first delimiter to find a later `DELIM)`
  // pattern, hiding injected commands between the two delimiters.
  type VerifiedHeredoc = { start: number; end: number }
  const verified: VerifiedHeredoc[] = []

  for (const { start, operatorEnd, delimiter, isDash } of safeHeredocs) {
    // The opening line must end immediately after the delimiter (only
    // horizontal whitespace allowed before the newline). If there's other
    // content (like `; rm -rf /`), this is not a simple safe heredoc.
    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) return false // No content at all
    const openLineTail = afterOperator.slice(0, openLineEnd)
    if (!/^[ \t]*$/.test(openLineTail)) return false // Extra content on open line

    // Body starts after the newline
    const bodyStart = operatorEnd + openLineEnd + 1
    const body = command.slice(bodyStart)
    const bodyLines = body.split('\n')

    // Find the FIRST line that closes the heredoc. There are two valid forms:
    //   1. `DELIM` alone on a line (bash-standard), followed by `)` on the
    //      next line (with only whitespace before it)
    //   2. `DELIM)` on a line (the inline $(cat <<'EOF'\n...\nEOF) form,
    //      where bash's PST_EOFTOKEN closes both heredoc and substitution)
    // For <<-, leading tabs are stripped before matching.
    let closingLineIdx = -1
    let closeParenLineIdx = -1 // Line index where `)` appears
    let closeParenColIdx = -1 // Column index of `)` on that line

    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine

      // Form 1: delimiter alone on a line
      if (line === delimiter) {
        closingLineIdx = i
        // The `)` must be on the NEXT line with only whitespace before it
        const nextLine = bodyLines[i + 1]
        if (nextLine === undefined) return false // No closing `)`
        const parenMatch = nextLine.match(/^([ \t]*)\)/)
        if (!parenMatch) return false // `)` not at start of next line
        closeParenLineIdx = i + 1
        closeParenColIdx = parenMatch[1]!.length // Position of `)`
        break
      }

      // Form 2: delimiter immediately followed by `)` (PST_EOFTOKEN form)
      // Only whitespace allowed between delimiter and `)`.
      if (line.startsWith(delimiter)) {
        const afterDelim = line.slice(delimiter.length)
        const parenMatch = afterDelim.match(/^([ \t]*)\)/)
        if (parenMatch) {
          closingLineIdx = i
          closeParenLineIdx = i
          // Column is in rawLine (pre-tab-strip), so recompute
          const tabPrefix = isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
          closeParenColIdx =
            tabPrefix.length + delimiter.length + parenMatch[1]!.length
          break
        }
        // Line starts with delimiter but has other trailing content —
        // this is NOT the closing line (bash requires exact match or EOF`)`).
        // But it's also a red flag: if this were inside $(), bash might
        // close early via PST_EOFTOKEN with other shell metacharacters.
        // We already handle that case in extractHeredocs — here we just
        // reject it as not matching our safe pattern.
        if (/^[)}`|&;(<>]/.test(afterDelim)) {
          return false // Ambiguous early-closure pattern
        }
      }
    }

    if (closingLineIdx === -1) return false // No closing delimiter found

    // Compute the absolute end position (one past the `)` character)
    let endPos = bodyStart
    for (let i = 0; i < closeParenLineIdx; i++) {
      endPos += bodyLines[i]!.length + 1 // +1 for newline
    }
    endPos += closeParenColIdx + 1 // +1 to include the `)` itself

    verified.push({ start, end: endPos })
  }

  // SECURITY: Reject nested matches. The regex finds $(cat <<'X' patterns
  // in RAW TEXT without understanding quoted-heredoc semantics. When the
  // outer heredoc has a quoted delimiter (<<'A'), its body is LITERAL text
  // in bash — any inner $(cat <<'B' is just characters, not a real heredoc.
  // But our regex matches both, producing NESTED ranges. Stripping nested
  // ranges corrupts indices: after stripping the inner range, the outer
  // range's `end` is stale (points past the shrunken string), causing
  // `remaining.slice(end)` to return '' and silently drop any suffix
  // (e.g., `; rm -rf /`). Since all our matched heredocs have quoted/escaped
  // delimiters, a nested match inside the body is ALWAYS literal text —
  // no legitimate user writes this pattern. Bail to safe fallback.
  for (const outer of verified) {
    for (const inner of verified) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) {
        return false
      }
    }
  }

  // Strip all verified heredocs from the command, building `remaining`.
  // Process in reverse order so earlier indices stay valid.
  const sortedVerified = [...verified].sort((a, b) => b.start - a.start)
  let remaining = command
  for (const { start, end } of sortedVerified) {
    remaining = remaining.slice(0, start) + remaining.slice(end)
  }

  // SECURITY: The remaining text must NOT start with only whitespace before
  // the (now-stripped) heredoc position IF there's non-whitespace after it.
  // If the $() is in COMMAND-NAME position (no prefix), its output becomes
  // the command to execute, with any suffix text as arguments:
  //   $(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow
  //   → runs `chmod 777 /etc/shadow`
  // We only allow the substitution in ARGUMENT position: there must be a
  // command word before the $(.
  // After stripping, `remaining` should look like `cmd args... [more args]`.
  // If remaining starts with only whitespace (or is empty), the $() WAS the
  // command — that's only safe if there are no trailing arguments.
  const trimmedRemaining = remaining.trim()
  if (trimmedRemaining.length > 0) {
    // There's a prefix command — good. But verify the original command
    // also had a non-whitespace prefix before the FIRST $( (the heredoc
    // could be one of several; we need the first one's prefix).
    const firstHeredocStart = Math.min(...verified.map(v => v.start))
    const prefix = command.slice(0, firstHeredocStart)
    if (prefix.trim().length === 0) {
      // $() is in command-name position but there's trailing text — UNSAFE.
      // The heredoc body becomes the command name, trailing text becomes args.
      return false
    }
  }

  // Check that remaining text contains only safe characters.
  // After stripping safe heredocs, the remaining text should only be command
  // names, arguments, quotes, and whitespace. Reject ANY shell metacharacter
  // to prevent operators (|, &, &&, ||, ;) or expansions ($, `, {, <, >) from
  // being used to chain dangerous commands after a safe heredoc.
  // SECURITY: Use explicit ASCII space/tab only — \s matches unicode whitespace
  // like \u00A0 which can be used to hide content. Newlines are also blocked
  // (they would indicate multi-line commands outside the heredoc body).
  if (!/^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)) return false

  // SECURITY: The remaining text (command with heredocs stripped) must also
  // pass all security validators. Without this, appending a safe heredoc to a
  // dangerous command (e.g., `zmodload zsh/system $(cat <<'EOF'\nx\nEOF\n)`)
  // causes this early-allow path to return passthrough, bypassing
  // validateZshDangerousCommands, validateProcEnvironAccess, and any other
  // main validator that checks allowlist-safe character patterns.
  // No recursion risk: `remaining` has no `$(... <<` pattern, so the recursive
  // call's validateSafeCommandSubstitution returns passthrough immediately.
  if (bashCommandIsSafe_DEPRECATED(remaining).behavior !== 'passthrough')
    return false

  return true
}

/**
 * Detects well-formed $(cat <<'DELIM'...DELIM) heredoc substitution patterns.
 * Returns the command with matched heredocs stripped, or null if none found.
 * Used by the pre-split gate to strip safe heredocs and re-check the remainder.
 */
export function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION.test(command)) return null

  const heredocPattern =
    /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  let result = command
  let found = false
  let match
  const ranges: Array<{ start: number; end: number }> = []
  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const isDash = match[1] === '-'
    const operatorEnd = match.index + match[0].length

    const afterOperator = command.slice(operatorEnd)
    const openLineEnd = afterOperator.indexOf('\n')
    if (openLineEnd === -1) continue
    if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) continue

    const bodyStart = operatorEnd + openLineEnd + 1
    const bodyLines = command.slice(bodyStart).split('\n')
    for (let i = 0; i < bodyLines.length; i++) {
      const rawLine = bodyLines[i]!
      const line = isDash ? rawLine.replace(/^\t*/, '') : rawLine
      if (line.startsWith(delimiter)) {
        const after = line.slice(delimiter.length)
        let closePos = -1
        if (/^[ \t]*\)/.test(after)) {
          const lineStart =
            bodyStart +
            bodyLines.slice(0, i).join('\n').length +
            (i > 0 ? 1 : 0)
          closePos = command.indexOf(')', lineStart)
        } else if (after === '') {
          const nextLine = bodyLines[i + 1]
          if (nextLine !== undefined && /^[ \t]*\)/.test(nextLine)) {
            const nextLineStart =
              bodyStart + bodyLines.slice(0, i + 1).join('\n').length + 1
            closePos = command.indexOf(')', nextLineStart)
          }
        }
        if (closePos !== -1) {
          ranges.push({ start: match.index, end: closePos + 1 })
          found = true
        }
        break
      }
    }
  }
  if (!found) return null
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!
    result = result.slice(0, r.start) + result.slice(r.end)
  }
  return result
}
