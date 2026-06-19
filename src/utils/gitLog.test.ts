import { describe, expect, test } from 'bun:test'
import { parseGitLog, parseStashList } from './gitLog.js'

const US = '\x1f'
const RS = '\x1e'

// Build a commit output line the way `git log --graph --format=<LOG_FORMAT>`
// would: optional graph prefix, then US-delimited H/h/an/s/d, then RS.
function commitLine(
  graphPrefix: string,
  hash: string,
  short: string,
  author: string,
  subject: string,
  decoration = '',
): string {
  return `${graphPrefix}${US}${hash}${US}${short}${US}${author}${US}${subject}${US}${decoration}${RS}`
}

describe('parseGitLog', () => {
  test('parses a simple commit row', () => {
    const out = parseGitLog(
      commitLine('* ', 'abc123def', 'abc123d', 'Jane', 'feat: thing'),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      graphPrefix: '* ',
      isCommit: true,
      hash: 'abc123def',
      shortHash: 'abc123d',
      author: 'Jane',
      subject: 'feat: thing',
      refs: [],
    })
  })

  test('extracts ref decorations and strips HEAD ->', () => {
    const out = parseGitLog(
      commitLine(
        '* ',
        'h1',
        'h1',
        'A',
        'subject',
        ' (HEAD -> main, origin/main, tag: v1)',
      ),
    )
    expect(out[0]?.refs).toEqual(['main', 'origin/main', 'tag: v1'])
  })

  test('marks graph-only connector lines as non-commit', () => {
    const stdout = [
      commitLine('* ', 'h1', 'h1', 'A', 'merge'),
      '|\\', // connector line, no US sentinel
      commitLine('| * ', 'h2', 'h2', 'B', 'fix'),
    ].join('\n')
    const out = parseGitLog(stdout)
    expect(out).toHaveLength(3)
    expect(out[0]?.isCommit).toBe(true)
    expect(out[1]).toMatchObject({ isCommit: false, graphPrefix: '|\\' })
    expect(out[2]?.isCommit).toBe(true)
  })

  test('subjects containing parentheses/commas survive', () => {
    const out = parseGitLog(
      commitLine('* ', 'h', 'h', 'A', 'feat(api): a, b, c'),
    )
    expect(out[0]?.subject).toBe('feat(api): a, b, c')
    expect(out[0]?.refs).toEqual([])
  })

  test('returns [] for empty output', () => {
    expect(parseGitLog('')).toEqual([])
    expect(parseGitLog('\n\n')).toEqual([])
  })
})

describe('parseStashList', () => {
  test('parses ref, subject and branch', () => {
    const stdout = [
      `${US}stash@{0}${US}WIP on main: abc123 tweak${RS}`,
      `${US}stash@{1}${US}On feature/x: manual stash${RS}`,
    ].join('\n')
    const out = parseStashList(stdout)
    expect(out).toEqual([
      { ref: 'stash@{0}', subject: 'WIP on main: abc123 tweak', branch: 'main' },
      {
        ref: 'stash@{1}',
        subject: 'On feature/x: manual stash',
        branch: 'feature/x',
      },
    ])
  })

  test('tolerates a subject with no recognizable branch', () => {
    const out = parseStashList(`${US}stash@{0}${US}custom message${RS}`)
    expect(out[0]).toMatchObject({ ref: 'stash@{0}', branch: '' })
  })

  test('returns [] for empty output', () => {
    expect(parseStashList('')).toEqual([])
  })
})
