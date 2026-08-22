import { describe, expect, test } from 'bun:test'

import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  bashCommandIsSafeAsync_DEPRECATED,
  bashCommandIsSafe_DEPRECATED,
  stripSafeHeredocSubstitutions,
} from 'src/tools/BashTool/bashSecurity.js'

/**
 * Narrows to the ask branch and reports whether it is flagged as a MISPARSING
 * concern — the flag the caller uses to block a command early.
 */
function askIsMisparsing(result: PermissionResult): boolean | undefined {
  if (result.behavior !== 'ask') {
    throw new Error(`expected an ask decision, got '${result.behavior}'`)
  }
  return result.isBashSecurityCheckForMisparsing
}

/**
 * Narrows to the ask branch and returns its message.
 *
 * Asserting the MESSAGE, not just the behavior, is what isolates one validator
 * from the other 22. All of them return 'ask' over the same input string, so a
 * behavior-only assertion survives deleting the validator under test whenever
 * any later one also fires. The message identifies which one answered.
 */
function askMessage(result: PermissionResult): string {
  if (result.behavior !== 'ask') {
    throw new Error(`expected an ask decision, got '${result.behavior}'`)
  }
  return result.message
}

function passthroughMessage(result: PermissionResult): string {
  if (result.behavior !== 'passthrough') {
    throw new Error(`expected a passthrough decision, got '${result.behavior}'`)
  }
  return result.message
}

describe('bashCommandIsSafe_DEPRECATED', () => {
  test('passes an ordinary command through', () => {
    expect(bashCommandIsSafe_DEPRECATED('ls -la').behavior).toBe('passthrough')
  })

  // Bash drops these silently; our validators do not, so metacharacters next to
  // one could otherwise slip past the checks that follow.
  test('asks for a command carrying control characters, flagged as misparsing', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\u0000 -la')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test("asks for the '\\' pattern that desyncs shell-quote's quote tracker", () => {
    const result = bashCommandIsSafe_DEPRECATED("ls '\\' *")
    expect(askIsMisparsing(result)).toBe(true)
  })

  // A redirection is a normal pattern, so its ask must NOT claim misparsing —
  // the caller only blocks early on the misparsing flag.
  test('asks for a redirection without flagging it as misparsing', () => {
    const result = bashCommandIsSafe_DEPRECATED('echo hi > out.txt')
    expect(askIsMisparsing(result)).toBeUndefined()
  })

  // The regression: a non-misparsing ask must be DEFERRED, not returned, or a
  // later misparsing validator never runs and the payload is let through.
  test('a later misparsing verdict wins over an earlier redirection ask', () => {
    const result = bashCommandIsSafe_DEPRECATED(
      'cat safe.txt \\; echo /etc/passwd > ./out',
    )
    expect(askIsMisparsing(result)).toBe(true)
  })
})

describe('stripSafeHeredocSubstitutions', () => {
  test('returns null when there is no heredoc substitution to strip', () => {
    expect(stripSafeHeredocSubstitutions('ls -la')).toBeNull()
    expect(stripSafeHeredocSubstitutions('echo $(id)')).toBeNull()
  })

  test('strips a well-formed quoted heredoc substitution', () => {
    const stripped = stripSafeHeredocSubstitutions(
      "git commit -m $(cat <<'EOF'\nsubject line\nEOF\n)",
    )
    expect(stripped).not.toBeNull()
    expect(stripped).not.toContain('subject line')
    expect(stripped).toContain('git commit -m')
  })

  test('leaves an unterminated heredoc substitution alone', () => {
    expect(
      stripSafeHeredocSubstitutions("echo $(cat <<'EOF'\nbody never closed"),
    ).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The four EARLY validators. Their results do not go through the deferral
// loop: an `allow` is rewritten to `passthrough` and returned, and any other
// non-passthrough returns immediately carrying the misparsing flag.
// ───────────────────────────────────────────────────────────────────────────

describe('early validators', () => {
  // validateEmpty: an empty command is allowed outright, and the dispatcher
  // converts that allow into a passthrough carrying the decisionReason text.
  test('an empty command is allowed and reported by its decision reason', () => {
    expect(passthroughMessage(bashCommandIsSafe_DEPRECATED('   '))).toBe(
      'Empty command is safe',
    )
  })

  // validateIncompleteCommands, one test per fragment shape it recognises.
  test('a command starting with a tab is treated as an incomplete fragment', () => {
    const result = bashCommandIsSafe_DEPRECATED('\tls -la')
    expect(askMessage(result)).toContain('starts with tab')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test('a command starting with a flag is treated as an incomplete fragment', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('-la'))).toContain(
      'starts with flags',
    )
  })

  test('a command starting with an operator is treated as a continuation line', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('&& ls'))).toContain(
      'continuation line',
    )
  })

  // validateSafeCommandSubstitution → isSafeHeredoc. This is the ONLY
  // early-allow path that bypasses all 19 main validators, so it is the one
  // that has to be provably safe rather than probably safe.
  test('a well-formed quoted heredoc in argument position is allowed outright', () => {
    expect(
      passthroughMessage(
        bashCommandIsSafe_DEPRECATED("echo $(cat <<'EOF'\nhello\nEOF\n)"),
      ),
    ).toContain('Safe command substitution')
  })

  // isSafeHeredoc requires a command word BEFORE the $(. Without one the
  // heredoc body becomes the command name and the trailing text its arguments
  // — so this must fall through to the generic $() validator instead.
  test('a heredoc in command-name position with trailing args is not allowed', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED(
          "$(cat <<'EOF'\nchmod\nEOF\n) 777 /etc/shadow",
        ),
      ),
    ).toContain('$() command substitution')
  })

  // validateGitCommit, the second early-allow path.
  test('a git commit with a simple quoted message is allowed outright', () => {
    expect(
      passthroughMessage(
        bashCommandIsSafe_DEPRECATED('git commit -m "fix thing"'),
      ),
    ).toContain('Git commit with simple quoted message')
  })

  test('a git commit message containing a substitution is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('git commit -m "fix $(whoami)"')),
    ).toContain('command substitution patterns')
  })

  // A message starting with `-` is the obfuscation shape; note validateGitCommit
  // answers this one itself rather than deferring to validateObfuscatedFlags.
  test('a git commit message starting with a dash is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('git commit -m "--amend"')),
    ).toContain('quoted characters in flag names')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The 19 main validators, reached by choosing an input that no earlier one
// flags. Each test asserts the message so that deleting the validator under
// test changes the answer even when a later validator also fires.
// ───────────────────────────────────────────────────────────────────────────

describe('main validators', () => {
  test('jq system() is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('jq \'system("ls")\' data.json')),
    ).toContain('system() function')
  })

  test('jq file-reading flags are asked about', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED('jq --rawfile x /etc/passwd . data.json'),
      ),
    ).toContain('dangerous flags')
  })

  // ANSI-C quoting can encode any byte, so it can hide a flag from every
  // downstream regex.
  test("ANSI-C quoting ($'...') is asked about", () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED("ls $'-la'"))).toContain(
      'ANSI-C quoting',
    )
  })

  test('locale quoting ($"...") is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('ls $"-la"'))).toContain(
      'locale quoting',
    )
  })

  // `''-name` concatenates in bash to `-name`, slipping the flag past a
  // prefix rule that only inspected the first word.
  test('empty quotes immediately before a dash are asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED("find . ''-name x")),
    ).toContain('empty quotes before dash')
  })

  // `"""-f"` is the homogeneous-empty-pair variant that the rule above misses:
  // the pair is followed by another quote rather than by the dash.
  test('an empty quote pair adjacent to a quoted dash is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('ls """-f"'))).toContain(
      'empty quote pair adjacent to quoted dash',
    )
  })

  // jq is the one base command whose double quotes survive extractQuotedContent
  // (isJq keeps them), which is what makes this validator's quoted-metachar
  // regexes reachable at all.
  test('a quoted shell metacharacter in a jq argument is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('jq -r "a;b" data.json')),
    ).toContain('shell metacharacters')
  })

  test('a variable piped into another command is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('cat $FOO | head')),
    ).toContain('variables in dangerous contexts')
  })

  // Quote chars inside a `#` comment are literal to bash but toggle our own
  // trackers, so the command has to be blocked before anything re-parses it.
  test('a quote character inside a # comment is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED("ls # it's here")),
    ).toContain('desync quote tracking')
  })

  // A newline inside quotes followed by a `#` line is what makes
  // stripCommentLines drop an argument that bash still passes.
  test('a quoted newline before a #-prefixed line is asked about', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED("mv ./decoy '\n#' ~/.ssh/id_rsa ./dir"),
      ),
    ).toContain('quoted newline')
  })

  // CR is a misparsing concern where LF is not: JS \s includes \r so
  // shell-quote splits on it, but bash's default IFS does not.
  test('a carriage return is asked about and flagged as misparsing', () => {
    const result = bashCommandIsSafe_DEPRECATED('TZ=UTC\recho hi')
    expect(askMessage(result)).toContain('carriage return')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test('an unquoted newline is asked about without the misparsing flag', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\nwhoami')
    expect(askMessage(result)).toContain('newlines that could separate')
    expect(askIsMisparsing(result)).toBeUndefined()
  })

  test('IFS usage is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('cat /etc$IFS/passwd')),
    ).toContain('IFS variable usage')
  })

  test('reading /proc/*/environ is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('cat /proc/self/environ')),
    ).toContain('/proc/*/environ')
  })

  // Backticks get their own branch because escaped ones (\`) are common in SQL
  // and must stay allowed.
  test('an unescaped backtick is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('echo `date`'))).toContain(
      'backticks',
    )
  })

  test('$() substitution is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('echo $(date)'))).toContain(
      '$() command substitution',
    )
  })

  test('process substitution is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('diff <(ls) <(ls)')),
    ).toContain('process substitution')
  })

  test('input redirection is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('cat < in.txt'))).toContain(
      'input redirection',
    )
  })

  // `echo\ test/../..` reads to the parser as an `echo` command but resolves in
  // bash through a directory literally named "echo test".
  test('backslash-escaped whitespace is asked about', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED('echo\\ test/../../usr/bin/touch /tmp/f'),
      ),
    ).toContain('backslash-escaped whitespace')
  })

  // splitCommand normalises `\;` to a bare `;`, so a re-parse of its output
  // sees two commands where bash sees one.
  test('a backslash before a shell operator is asked about', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED('cat safe.txt \\; echo /etc/passwd'),
      ),
    ).toContain('backslash before a shell operator')
  })

  test('Unicode whitespace is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('ls\u00a0-la'))).toContain(
      'Unicode whitespace',
    )
  })

  // shell-quote reads a mid-word `#` as comment-start; bash reads it as a
  // literal character.
  test('a mid-word hash is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('ls foo#bar'))).toContain(
      'mid-word #',
    )
  })

  test('brace expansion with a comma is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('git diff {a,b}')),
    ).toContain('brace expansion that could alter')
  })

  // More `}` than `{` after quote stripping means a quoted `{` was removed, so
  // the depth matcher below can no longer be trusted on this input.
  test('excess closing braces after quote stripping are asked about', () => {
    expect(
      askMessage(
        bashCommandIsSafe_DEPRECATED("git diff {@'{'0},--output=/tmp/pwned}"),
      ),
    ).toContain('excess closing braces')
  })

  test('a Zsh module command is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('zmodload zsh/system')),
    ).toContain("'zmodload'")
  })

  // `fc` alone only lists history; `-e` makes it run an editor on it.
  test('fc -e is asked about', () => {
    expect(askMessage(bashCommandIsSafe_DEPRECATED('fc -e vi'))).toContain(
      "'fc -e'",
    )
  })

  test('an unbalanced quote combined with a separator is asked about', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('echo "unbalanced ; ls')),
    ).toContain('ambiguous syntax')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// The dispatcher's own contract. These are what a reordered or re-grouped
// validator array in a future bashSecurity/validators/ split would break, and
// none of them is visible from any single validator's own test.
// ───────────────────────────────────────────────────────────────────────────

describe('dispatcher deferral rule', () => {
  // The two non-misparsing validators must not short-circuit the loop.
  test('a misparsing verdict wins over a deferred newline ask', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\nwhoami $IFS')
    expect(askMessage(result)).toContain('IFS variable usage')
    expect(askIsMisparsing(result)).toBe(true)
  })

  // ...and when nothing misparsing fires, the deferred verdict is what comes
  // back — unflagged, so the caller lets it reach the normal permission flow.
  test('the deferred ask is returned when no misparsing validator fires', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\nwhoami')
    expect(askMessage(result)).toContain('newlines that could separate')
    expect(askIsMisparsing(result)).toBeUndefined()
  })
})

describe('a misparsing verdict survives an accompanying newline', () => {
  // The array comments say validateCommentQuoteDesync, validateQuotedNewline
  // and validateCarriageReturn must each run BEFORE validateNewlines. That
  // ordering is NOT what protects these inputs, and these tests do not claim it
  // is: moving validateNewlines to the front of the array leaves all three
  // green, because validateNewlines defers instead of short-circuiting.
  //
  // What they DO pin is the property the ordering was meant to buy — for an
  // input carrying both an unquoted newline and one of these three concerns,
  // the misparsing verdict is what reaches the caller, flagged.
  test('comment-quote desync outlives a newline in the same command', () => {
    const result = bashCommandIsSafe_DEPRECATED("ls # it's here\nwhoami")
    expect(askMessage(result)).toContain('desync quote tracking')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test('quoted-newline outlives a newline in the same command', () => {
    const result = bashCommandIsSafe_DEPRECATED("mv ./decoy '\n#' x\nls")
    expect(askMessage(result)).toContain('quoted newline')
    expect(askIsMisparsing(result)).toBe(true)
  })

  test('carriage-return outlives a newline in the same command', () => {
    const result = bashCommandIsSafe_DEPRECATED('ls\r\nwhoami')
    expect(askMessage(result)).toContain('carriage return')
    expect(askIsMisparsing(result)).toBe(true)
  })
})

describe('validator order', () => {
  // Among the MISPARSING validators order IS observable: the first to fire
  // returns immediately, so its message is the one the caller sees. These pin
  // two such pairs, which is the drift a re-grouped validators/ directory
  // would introduce.
  test('jq validation answers before the generic substitution check', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED('jq \'system("x")\' $(date)')),
    ).toContain('system() function')
  })

  test('obfuscated-flag detection answers before the generic substitution check', () => {
    expect(
      askMessage(bashCommandIsSafe_DEPRECATED("ls $'-x' $(date)")),
    ).toContain('ANSI-C quoting')
  })
})

describe('bashCommandIsSafeAsync_DEPRECATED', () => {
  // NAMED FOR WHAT IT PINS: the fallback at the top of the async entry point,
  // not parity of the two validator arrays.
  //
  // tree-sitter is not available under `bun test` (ParsedCommand.parse returns
  // no analysis), so the async function's own ~90-line duplicate of the
  // dispatcher body is UNREACHABLE here — verified by deleting
  // validateIFSInjection from the async array, which changed no result. Every
  // assertion below is therefore served by bashCommandIsSafe_DEPRECATED via
  // the `if (!tsAnalysis)` fallback, and this suite CANNOT detect the two
  // arrays drifting apart. Breaking that fallback line is what these fail on.
  const CASES = [
    'ls -la',
    'ls\u0000 -la',
    'echo hi > out.txt',
    'cat safe.txt \\; echo /etc/passwd > ./out',
    'git commit -m "fix thing"',
    "echo $(cat <<'EOF'\nhello\nEOF\n)",
    'ls\nwhoami $IFS',
  ]

  test('delegates to the sync path when tree-sitter is unavailable', async () => {
    for (const command of CASES) {
      const sync = bashCommandIsSafe_DEPRECATED(command)
      const async_ = await bashCommandIsSafeAsync_DEPRECATED(command)
      expect({ command, ...async_ }).toEqual({ command, ...sync })
    }
  })
})
