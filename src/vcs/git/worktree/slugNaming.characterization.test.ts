/**
 * Characterization of worktree names, pinned for the clean-base rewrite
 * (docs/tech/rewrite/vcs/worktree.md): which slugs are accepted, what the
 * refusal says, and the branch a slug maps to. Where the slug lands on disk is
 * pinned by the creation suite, which builds real worktrees.
 *
 * The refusals reach the model (EnterWorktree validates its `name` with this),
 * so the messages are pinned by the facts they carry, not by their wording.
 */
import { describe, expect, test } from 'bun:test'

import { validateWorktreeSlug, worktreeBranchName } from 'src/vcs/git/worktree.js'

function refusalOf(slug: string): string | null {
  try {
    validateWorktreeSlug(slug)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

describe('validateWorktreeSlug accepts', () => {
  // Plain segments, every allowed character class, nesting, dots inside or at
  // the start of a segment, the agent and workflow slug shapes, and exactly 64
  // characters in one segment or across two.
  const accepted = 'feature fix-1234 Az09._- team/alice/login v1.2 .hidden/..x/x.. agent-a0f3c9e wf_1a2b3c4d-5e6-12'
    .split(' ')
    .concat('q'.repeat(64), `${'m'.repeat(31)}/${'n'.repeat(32)}`)
  for (const slug of accepted) {
    test(`accepts ${slug.length > 20 ? `${slug.length} characters` : slug}`, () => {
      expect(refusalOf(slug)).toBeNull()
    })
  }

  test('returns nothing, synchronously', () => {
    expect(validateWorktreeSlug('sync-check')).toBeUndefined()
  })
})

describe('validateWorktreeSlug refuses', () => {
  type Refusal = { slug: string; kind: 'length' | 'dots' | 'charset' }
  const refused: Array<[string, Refusal]> = [
    ['65 characters', { slug: 'z'.repeat(65), kind: 'length' }],
    ['a long slug even when its characters are also bad', { slug: '$'.repeat(90), kind: 'length' }],
    ['a lone dot', { slug: '.', kind: 'dots' }],
    ['a lone double dot', { slug: '..', kind: 'dots' }],
    ['a climb out of the worktrees directory', { slug: '../../outside', kind: 'dots' }],
    ['a climb in the middle', { slug: 'x/../y', kind: 'dots' }],
    ['a dot segment at the end', { slug: 'x/.', kind: 'dots' }],
    ['the empty string', { slug: '', kind: 'charset' }],
    ['a leading slash (an absolute path)', { slug: '/tmp/x', kind: 'charset' }],
    ['a trailing slash', { slug: 'x/', kind: 'charset' }],
    ['an empty middle segment', { slug: 'x//y', kind: 'charset' }],
    ['a backslash', { slug: 'x\\y', kind: 'charset' }],
    ['a drive letter', { slug: 'C:', kind: 'charset' }],
    ['a space', { slug: 'two words', kind: 'charset' }],
    ['a plus, which the branch mapping reserves', { slug: 'x+y', kind: 'charset' }],
    ['shell metacharacters', { slug: 'x;rm', kind: 'charset' }],
    ['a tilde', { slug: '~x', kind: 'charset' }],
    ['a newline', { slug: 'x\ny', kind: 'charset' }],
    ['a non-ASCII letter', { slug: 'caf\u00e9', kind: 'charset' }],
  ]

  for (const [label, { slug, kind }] of refused) {
    test(`${label}: ${kind}`, () => {
      const message = refusalOf(slug)
      expect(message).not.toBeNull()
      expect(message).toMatch(/^Invalid worktree name/)
      if (kind === 'length') {
        expect(message).toMatch(/\b64\b/)
        expect(message).toContain(String(slug.length))
        expect(message).not.toContain('"."')
        return
      }
      expect(message).toContain(`"${slug}"`)
      if (kind === 'dots') {
        expect(message).toContain('"."')
        expect(message).toContain('".."')
        return
      }
      expect(message).toContain('non-empty')
      for (const allowed of ['letters', 'digits', 'dots', 'underscores', 'dashes']) {
        expect(message).toContain(allowed)
      }
    })
  }

  // The first offending segment decides, and each refusal names its own rule only.
  const firstOffence = [
    { slug: 'bad char/..', names: 'letters', never: '".."' },
    { slug: '../bad char', names: '".."', never: 'letters' },
  ]
  for (const { slug, names, never } of firstOffence) {
    test(`judged left to right: ${slug}`, () => {
      const message = refusalOf(slug) ?? ''
      expect({ names: message.includes(names), never: message.includes(never) }).toEqual({
        names: true,
        never: false,
      })
    })
  }
})

describe('worktreeBranchName', () => {
  const mapped = 'feature=worktree-feature v1.2_rc-3=worktree-v1.2_rc-3 team/alice=worktree-team+alice a/b/c/d=worktree-a+b+c+d pr-42=worktree-pr-42'
    .split(' ')
    .map(pair => pair.split('='))
  for (const [slug = '', branch] of mapped) {
    test(`${slug} -> ${branch}`, () => {
      expect(worktreeBranchName(slug)).toBe(branch)
    })
  }

  test('does not validate: whatever it is given is mapped', () => {
    expect(worktreeBranchName('not valid/at all')).toBe('worktree-not valid+at all')
  })

  test('distinct valid slugs never share a branch', () => {
    const slugs = ['a/b', 'a-b', 'a.b', 'a_b', 'ab', 'a/b/c', 'a/bc', 'ab/c', 'a', 'b']
    for (const slug of slugs) expect(refusalOf(slug)).toBeNull()
    const branches = new Set(slugs.map(worktreeBranchName))
    expect(branches.size).toBe(slugs.length)
    // The only spelling that could collide with a nested slug is refused.
    expect(refusalOf('a+b')).not.toBeNull()
  })
})
