/**
 * The pure decisions behind the unit, driven directly: the fast path's
 * command line, the relaunch command, the base plan, the include selection and
 * the worktree listing.
 */
import { describe, expect, test } from 'bun:test'

import {
  baseSourceFor,
  defaultBranchPlan,
  LOCAL_HEAD_PLAN,
  pullRequestPlan,
} from 'src/vcs/git/worktree/baseChoice.js'
import { readIncludeRules, shouldOpenDirectory, splitNulListing } from 'src/vcs/git/worktree/includeSelection.js'
import {
  inventWorktreeName,
  readFastPathArgs,
  relaunchCommand,
  tmuxInstallHint,
  worktreeTarget,
} from 'src/vcs/git/worktree/tmuxLaunch.js'
import { parseWorktreeList } from 'src/vcs/git/worktree/worktreeList.js'

describe('readFastPathArgs', () => {
  const cases: Array<[string, string[], { name: string | null; classic: boolean; forwarded: string[] }]> = [
    ['-w with a value', ['-w', 'one', '--tmux'], { name: 'one', classic: false, forwarded: [] }],
    ['--worktree= form', ['--worktree=two', '--tmux=classic', 'p'], { name: 'two', classic: true, forwarded: ['p'] }],
    ['the last naming occurrence wins', ['-w', 'a', '--worktree', 'b'], { name: 'b', classic: false, forwarded: [] }],
    ['a flag after -w names nothing', ['-w', 'a', '-w', '--model', 'x'], { name: 'a', classic: false, forwarded: ['--model', 'x'] }],
    ['a trailing -w names nothing', ['--tmux', '--worktree'], { name: null, classic: false, forwarded: [] }],
    ['empty strings are dropped', ['', '-p', '', 'hi'], { name: null, classic: false, forwarded: ['-p', 'hi'] }],
  ]
  for (const [label, args, expected] of cases) {
    test(label, () => {
      expect(readFastPathArgs(args)).toEqual(expected)
    })
  }
})

describe('worktreeTarget and inventWorktreeName', () => {
  test('a pull request names its worktree pr-<n>', () => {
    expect(worktreeTarget('#5', 5)).toEqual({ slug: 'pr-5', prNumber: 5 })
    expect(worktreeTarget('feature', null)).toEqual({ slug: 'feature' })
  })

  test('an invented name is adjective-noun-suffix', () => {
    expect(inventWorktreeName(() => 0)).toBe('swift-fox-')
    expect(inventWorktreeName(() => 0.99)).toMatch(/^bold-ray-[0-9a-z]{1,4}$/)
  })
})

describe('F3: relaunchCommand', () => {
  const cases: Array<[string, { runtime: string; script: string | null }, string[]]> = [
    ['a compiled binary relaunches itself', { runtime: '/bin/claudin', script: null }, ['/bin/claudin', '-p', 'x']],
    ['node gets its script back', { runtime: '/usr/bin/node', script: '/app/dist/cli.mjs' }, ['/usr/bin/node', '/app/dist/cli.mjs', '-p', 'x']],
  ]
  for (const [label, launch, expected] of cases) {
    test(label, () => {
      expect(relaunchCommand(launch, ['-p', 'x'])).toEqual(expected)
    })
  }
})

describe('F6: one install hint per platform', () => {
  test('every platform has its hint', () => {
    expect(tmuxInstallHint('macos')).toContain('brew install tmux')
    expect(tmuxInstallHint('wsl')).toBe(tmuxInstallHint('linux'))
    expect(tmuxInstallHint('linux')).toContain('sudo dnf install tmux')
  })
})

describe('the base plan', () => {
  test('a pull request wins, 0 is no pull request, then baseRef head', () => {
    expect(baseSourceFor(3, 'head')).toEqual({ kind: 'pull-request', prNumber: 3 })
    expect(baseSourceFor(0, 'head')).toEqual({ kind: 'local-head' })
    expect(baseSourceFor(undefined, 'fresh')).toEqual({ kind: 'default-branch' })
    expect(baseSourceFor(undefined, undefined)).toEqual({ kind: 'default-branch' })
  })

  test('plans', () => {
    expect(pullRequestPlan(7)).toEqual({ fetch: 'pull/7/head', ref: 'FETCH_HEAD', fallback: null })
    expect(LOCAL_HEAD_PLAN).toEqual({ fetch: null, ref: 'HEAD', fallback: null })
    expect(defaultBranchPlan('trunk', true)).toEqual({ fetch: null, ref: 'origin/trunk', fallback: null })
    expect(defaultBranchPlan('trunk', false)).toEqual({ fetch: 'trunk', ref: 'origin/trunk', fallback: 'HEAD' })
  })
})

describe('the include selection', () => {
  test('patterns are what gitignore reads', () => {
    expect(readIncludeRules('# c\r\n\r\n  \r\n.env  \r\n  lead\r\n').patterns).toEqual(['.env', '  lead'])
  })

  const rules = readIncludeRules(['config/secrets/api.key', 'config/**/*.pem', 'build', '*.key', '!keep/x', '/anchored/deep/f'].join('\n'))
  const directories: Array<[string, boolean]> = [
    ['config/secrets/', true],
    ['config/certs/', true],
    ['build/', true],
    ['node_modules/', false],
    ['keep/', false],
    ['anchored/', true],
    ['anchored/deep/', true],
    ['other/', false],
  ]
  for (const [dir, opened] of directories) {
    test(`${dir} is ${opened ? '' : 'not '}opened`, () => {
      expect(shouldOpenDirectory(rules, dir)).toBe(opened)
    })
  }

  test('a NUL listing keeps every name verbatim', () => {
    expect(splitNulListing('caf\u00e9\0a "b"\0dir/\0')).toEqual(['caf\u00e9', 'a "b"', 'dir/'])
  })
})

describe('parseWorktreeList', () => {
  test('records, branches and detached heads', () => {
    const listing = [
      'worktree /r', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /r/w', 'HEAD bbb', 'detached', '',
      'worktree /gone', 'HEAD ccc', 'branch refs/heads/feat/x', 'prunable gitdir file points to non-existent location', '',
    ].join('\0')
    expect(parseWorktreeList(listing)).toEqual([
      { path: '/r', head: 'aaa', branch: 'main' },
      { path: '/r/w', head: 'bbb', branch: null },
      { path: '/gone', head: 'ccc', branch: 'feat/x' },
    ])
  })
})
