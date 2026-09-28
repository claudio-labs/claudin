import { describe, expect, test } from 'bun:test'
import { isAcceptedRefName, isObjectId } from 'src/vcs/git/gitFilesystem/refNames.js'

describe('isAcceptedRefName', () => {
  test.each([
    'main',
    'feature/login',
    'release-1.2.3+build',
    'dependabot/npm_and_yarn/@types/node-18.0.0',
    'UP/Case_9',
    'user@host',
    'v1.x',
    'refs/remotes/origin/main',
  ])('accepts %p', name => {
    expect(isAcceptedRefName(name)).toBe(true)
  })

  test.each([
    ['empty', ''],
    ['leading dash', '-rf'],
    ['leading slash', '/rooted'],
    ['trailing slash', 'feature/'],
    ['empty component', 'a//b'],
    ['dot component', 'a/./b'],
    ['dot-dot anywhere', 'a..b'],
    ['traversal', '../../x'],
    ['reflog syntax', 'up@{1}'],
    ['blank', 'a b'],
    ['tab', 'a\tb'],
    ['newline', 'a\nb'],
    ['shell substitution', '$(touch owned)'],
    ['semicolon', 'a;b'],
    ['backticks', 'a`b`'],
    ['non-ASCII letter', 'feature/ação'],
    ['hash', 'fix/#123'],
  ])('refuses %s', (_label, name) => {
    expect(isAcceptedRefName(name)).toBe(false)
  })

  // F3: a reftable repository leaves `ref: refs/heads/.invalid` in HEAD.
  test.each(['.invalid', 'refs/heads/.invalid', 'feature/.hidden', '.config/x'])(
    'refuses a component that begins with a dot, as git does: %p',
    name => {
      expect(isAcceptedRefName(name)).toBe(false)
    },
  )
})

describe('isObjectId', () => {
  const sha1 = 'ab'.repeat(20)
  const sha256 = 'cd'.repeat(32)

  test('full lowercase SHA-1 and SHA-256 ids', () => {
    expect(isObjectId(sha1)).toBe(true)
    expect(isObjectId(sha256)).toBe(true)
  })

  test.each([
    ['uppercase', sha1.toUpperCase()],
    ['abbreviated', sha1.slice(0, 12)],
    ['one digit short', sha1.slice(0, 39)],
    ['between the two lengths', `${sha1}0`],
    ['too long', `${sha256}0`],
    ['padded', ` ${sha1}`],
    ['trailing newline', `${sha1}\n`],
    ['not hex', 'g'.repeat(40)],
  ])('refuses %s', (_label, text) => {
    expect(isObjectId(text)).toBe(false)
  })
})
