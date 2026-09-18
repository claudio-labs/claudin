import { describe, expect, test } from 'bun:test'
import { splitCommand_DEPRECATED } from 'src/platform/bash/commands.js'

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
})
