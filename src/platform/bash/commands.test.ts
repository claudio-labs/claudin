import { describe, expect, test } from 'bun:test'
import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from 'src/platform/bash/commands.js'

// `splitCommand_DEPRECATED` is what the permission path actually splits a
// compound command with — the AST parser beside it has never produced a tree in
// a shipped bundle. It had no direct test; the cases below are the ones its own
// SECURITY comments describe, so that the redirect-stripping loop cannot be
// simplified without something going red.
describe('splitCommand_DEPRECATED', () => {
  test('splits on control operators and drops the operators', () => {
    expect(splitCommand_DEPRECATED('ls && git push')).toEqual([
      'ls',
      'git push',
    ])
    expect(splitCommand_DEPRECATED('a; b || c')).toEqual(['a', 'b', 'c'])
  })

  test('a command with no operator comes back as one entry', () => {
    expect(splitCommand_DEPRECATED('git status')).toEqual(['git status'])
  })

  test('strips a file redirection so it is not prompted as a command', () => {
    expect(splitCommand_DEPRECATED('echo hi > out.txt')).toEqual(['echo hi'])
    expect(splitCommand_DEPRECATED('echo hi >> out.txt')).toEqual(['echo hi'])
  })

  test('strips a file-descriptor duplication', () => {
    expect(splitCommand_DEPRECATED('make 2>&1')).toEqual(['make'])
  })

  test('strips the collapsed `> /dev/null 2>&1` pair', () => {
    expect(splitCommand_DEPRECATED('ls > /dev/null 2>&1')).toEqual(['ls'])
  })

  // SECURITY (commands.ts:342-346): shell-quote cannot tell `2>` from `2 >`, so
  // the FD strip requires a preceding SPACE. Without it, a path merely ENDING
  // in a digit loses its last character.
  test('a path ending in a digit survives a following redirect', () => {
    expect(splitCommand_DEPRECATED('cat /tmp/path2 > out')).toEqual([
      'cat /tmp/path2',
    ])
  })

  // SECURITY (same comment): the length check keeps a bare digit that is its
  // own subcommand from being erased.
  test('a bare digit subcommand is not erased by the FD strip', () => {
    expect(splitCommand_DEPRECATED('echo ; 2 > file')).toEqual(['echo', '2'])
  })

  // shell-quote 1.11 decodes `$'…'` (dropping the `$` and expanding `\x27`
  // into a quote). The validators run on the text returned here, so it must
  // be what bash will read — the per-subcommand ANSI-C check looks for `$'`.
  test("ANSI-C quoting comes back verbatim, not decoded", () => {
    expect(
      splitCommand_DEPRECATED(
        "echo hi\ngit diff -G $'a\\x27b' --output=/tmp/out -G $'c\\x27d'",
      ),
    ).toEqual([
      'echo hi',
      "git diff -G $'a\\x27b' --output=/tmp/out -G $'c\\x27d'",
    ])
    expect(splitCommand_DEPRECATED("ls $'a;b' && pwd")).toEqual([
      "ls $'a;b'",
      'pwd',
    ])
  })
})

// Every target this returns is path-validated by checkPathConstraints, and a
// target it neither returns nor flags is never validated at all — the
// invariant hasDangerousExpansion's doc comment states. It had no direct test.
describe('extractOutputRedirections', () => {
  test('captures the target of `>` and `>>` and strips it from the command', () => {
    expect(extractOutputRedirections('echo hi > out.txt')).toEqual({
      commandWithoutRedirections: 'echo hi',
      redirections: [{ target: 'out.txt', operator: '>' }],
      hasDangerousRedirection: false,
    })
    expect(extractOutputRedirections('echo hi >> out.txt')).toEqual({
      commandWithoutRedirections: 'echo hi',
      redirections: [{ target: 'out.txt', operator: '>>' }],
      hasDangerousRedirection: false,
    })
  })

  test('a non-stdout fd keeps its redirection in the command', () => {
    expect(extractOutputRedirections('make 2> err.log')).toEqual({
      commandWithoutRedirections: 'make 2> err.log',
      redirections: [{ target: 'err.log', operator: '>' }],
      hasDangerousRedirection: false,
    })
  })

  test('fd duplication is not a file target', () => {
    expect(extractOutputRedirections('make 2>&1')).toEqual({
      commandWithoutRedirections: 'make 2>&1',
      redirections: [],
      hasDangerousRedirection: false,
    })
  })

  test('`>&` with a file sends both streams to it', () => {
    expect(extractOutputRedirections('make >& all.log').redirections).toEqual([
      { target: 'all.log', operator: '>' },
    ])
  })

  test('zsh `>!` force-clobber validates the target without the `!`', () => {
    expect(extractOutputRedirections('echo hi >!out.txt').redirections).toEqual(
      [{ target: 'out.txt', operator: '>' }],
    )
  })

  test('a target that expands is flagged instead of captured', () => {
    for (const command of [
      'echo hi > $HOME/x',
      'echo hi > ~/.bashrc',
      'echo hi > *.sh',
      'echo hi > `pwd`/x',
    ]) {
      const result = extractOutputRedirections(command)
      expect(result.hasDangerousRedirection).toBe(true)
      expect(result.redirections).toEqual([])
    }
  })

  // SECURITY (commands.ts:668-675): the quoted-heredoc body ends at the first
  // `ls`, so the `> /etc/passwd` after it is a real redirect bash executes.
  test('a redirect after a quoted heredoc is still captured', () => {
    const result = extractOutputRedirections(
      "cat <<'ls'\nx\\\nls\n> /etc/passwd\nls",
    )
    expect(result.redirections).toEqual([
      { target: '/etc/passwd', operator: '>' },
    ])
  })

  test('a command shell-quote cannot parse fails closed', () => {
    expect(extractOutputRedirections('echo ${} > out.txt')).toEqual({
      commandWithoutRedirections: 'echo ${} > out.txt',
      redirections: [],
      hasDangerousRedirection: true,
    })
  })
})
