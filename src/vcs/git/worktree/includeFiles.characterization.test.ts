/**
 * Characterization of `copyWorktreeIncludeFiles`, pinned for the clean-base
 * rewrite (docs/tech/rewrite/vcs/worktree.md): which gitignored files of the
 * main checkout a new worktree receives, and exactly what lands on disk.
 *
 * The main case uses two fixtures in `__fixtures__/rewrite/`:
 * `worktreeinclude` is the include file, and `worktreeinclude.copied.txt` is
 * what the real code copied from the repository built below, in the order it
 * reported. Each test compares the worktree's files before and after the call,
 * so anything created beyond the expected copies is caught.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join, relative } from 'path'

import { openWorktreeLab, type WorktreeLab } from 'src/vcs/git/__testutils__/worktreeLab.js'
import { copyWorktreeIncludeFiles } from 'src/vcs/git/worktree.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')

const IGNORE_RULES = [
  '.env',
  '.env.*',
  'secret.txt',
  '*.key',
  'config/secrets/',
  'config/certs/',
  'build/',
  'node_modules/',
]

/** Untracked and ignored: the candidates. Contents are unique per file. */
const IGNORED_FILES = [
  '.env',
  '.env.local',
  '.env.prod',
  'secret.txt',
  'top.key',
  'config/local.key',
  'config/secrets/api.key',
  'config/secrets/other.txt',
  'config/certs/site.pem',
  'config/certs/readme.txt',
  'build/out.js',
  'build/nested/deep.map',
  'node_modules/pkg/index.js',
  'node_modules/pkg/cert.key',
]

let lab: WorktreeLab

beforeEach(() => {
  lab = openWorktreeLab()
})

afterEach(() => {
  lab.close()
})

const contentOf = (path: string): string => `contents of ${path}\n`

/** Every file under `root`, relative and sorted, leaving out `.git`. */
function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else found.push(relative(root, path))
    }
  }
  walk(root)
  return found.sort()
}

/**
 * A repository with the ignore rules above committed, every ignored file
 * present, one untracked file that is not ignored, and a linked worktree.
 */
function mainCheckout(label: string, include: string | null): { repo: string; worktree: string } {
  const repo = lab.git.repo(label)
  lab.git.put(repo, '.gitignore', `${IGNORE_RULES.join('\n')}\n`)
  lab.git.put(repo, 'config/app.json', '{"tracked":true}\n')
  lab.git.run(repo, 'add', '.')
  lab.git.run(repo, 'commit', '-q', '-m', 'tracked layout')
  for (const path of IGNORED_FILES) lab.git.put(repo, path, contentOf(path))
  lab.git.put(repo, 'scratch.txt', 'untracked, not ignored\n')
  if (include !== null) lab.git.put(repo, '.worktreeinclude', include)
  const worktree = join(lab.git.tempDir(`${label}-wt`), 'tree')
  lab.git.run(repo, 'worktree', 'add', '-q', '-b', `${label}-side`, worktree)
  return { repo, worktree }
}

async function copyAndDiff(
  repo: string,
  worktree: string,
): Promise<{ reported: string[]; added: string[] }> {
  const before = new Set(filesUnder(worktree))
  const reported = await copyWorktreeIncludeFiles(repo, worktree)
  const added = filesUnder(worktree).filter(path => !before.has(path))
  return { reported, added }
}

describe('copyWorktreeIncludeFiles with the fixture include file', () => {
  test('copies exactly the listed files, byte for byte, in the listed order', async () => {
    const include = readFileSync(join(FIXTURES, 'worktreeinclude'), 'utf8')
    const expected = readFileSync(join(FIXTURES, 'worktreeinclude.copied.txt'), 'utf8')
      .split('\n')
      .filter(Boolean)
    const { repo, worktree } = mainCheckout('fixture', include)
    const { reported, added } = await copyAndDiff(repo, worktree)
    expect(reported).toEqual(expected)
    expect(added).toEqual([...expected].sort())
    for (const path of expected) {
      expect(readFileSync(join(worktree, path), 'utf8')).toBe(contentOf(path))
    }
  })

  test('the rules behind the fixture, one by one', async () => {
    const include = readFileSync(join(FIXTURES, 'worktreeinclude'), 'utf8')
    const { repo, worktree } = mainCheckout('rules', include)
    const { reported } = await copyAndDiff(repo, worktree)
    const verdicts: Array<[string, boolean, string]> = [
      ['.env', true, 'a listed ignored file'],
      ['.env.local', true, 'a glob'],
      ['.env.prod', false, 'a negation wins over the glob before it'],
      ['secret.txt', false, 'ignored but not listed'],
      ['scratch.txt', false, 'listed nowhere and not ignored'],
      ['top.key', true, 'an anchorless glob, for a file git lists on its own'],
      ['config/local.key', true, 'the same glob, beside a tracked file'],
      ['config/secrets/api.key', true, 'a path inside a wholly ignored directory'],
      ['config/secrets/other.txt', false, 'its unlisted neighbour'],
      ['config/certs/site.pem', true, 'an anchored glob reaches into an ignored directory'],
      ['config/certs/readme.txt', false, 'what that glob does not match'],
      ['build/out.js', true, 'a listed directory brings everything under it'],
      ['build/nested/deep.map', true, 'at any depth'],
      ['node_modules/pkg/cert.key', false, 'an anchorless glob never reaches into an ignored directory'],
      ['node_modules/pkg/index.js', false, 'an unlisted ignored directory'],
      ['config/app.json', false, 'tracked files come from the checkout, not from here'],
    ]
    for (const [path, copied, why] of verdicts) {
      expect({ path, why, copied: reported.includes(path) }).toEqual({ path, why, copied })
    }
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })
})

describe('copyWorktreeIncludeFiles edge cases', () => {
  test('without a .worktreeinclude nothing is copied', async () => {
    const { repo, worktree } = mainCheckout('absent', null)
    expect(await copyAndDiff(repo, worktree)).toEqual({ reported: [], added: [] })
  })

  test('an include file of comments and blank lines copies nothing', async () => {
    const { repo, worktree } = mainCheckout('comments', '# .env\n\n   \n#*.key\n')
    expect(await copyAndDiff(repo, worktree)).toEqual({ reported: [], added: [] })
  })

  test('CRLF line endings are accepted', async () => {
    const { repo, worktree } = mainCheckout('crlf', '.env\r\ntop.key\r\n')
    const { reported } = await copyAndDiff(repo, worktree)
    expect(reported).toEqual(['.env', 'top.key'])
  })

  test('blanks follow gitignore: trailing ones are dropped, leading ones are part of the name', async () => {
    const { repo, worktree } = mainCheckout('blanks', '.env   \n  top.key\n')
    const { reported } = await copyAndDiff(repo, worktree)
    expect(reported).toEqual(['.env'])
  })

  test('a leading slash anchors a path inside an ignored directory', async () => {
    const { repo, worktree } = mainCheckout('anchored', '/config/secrets/api.key\n')
    expect(await copyAndDiff(repo, worktree)).toEqual({
      reported: ['config/secrets/api.key'],
      added: ['config/secrets/api.key'],
    })
  })

  test('a repository with nothing ignored copies nothing', async () => {
    const repo = lab.git.repo('clean')
    lab.git.put(repo, '.worktreeinclude', '*\n')
    const worktree = join(lab.git.tempDir('clean-wt'), 'tree')
    lab.git.run(repo, 'worktree', 'add', '-q', '-b', 'clean-side', worktree)
    expect(await copyAndDiff(repo, worktree)).toEqual({ reported: [], added: [] })
  })

  test('a directory that is not a repository copies nothing', async () => {
    const plain = lab.git.tempDir('plain')
    lab.git.put(plain, '.worktreeinclude', '.env\n')
    lab.git.put(plain, '.env', 'x\n')
    const target = lab.git.tempDir('plain-target')
    expect(await copyAndDiff(plain, target)).toEqual({ reported: [], added: [] })
  })

  test('an existing file in the worktree is overwritten', async () => {
    const { repo, worktree } = mainCheckout('overwrite', '.env\n')
    writeFileSync(join(worktree, '.env'), 'stale\n')
    const { reported } = await copyAndDiff(repo, worktree)
    expect(reported).toEqual(['.env'])
    expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe(contentOf('.env'))
  })

  test('a file that cannot be read is skipped and the rest still copied', async () => {
    if (process.getuid?.() === 0) return
    const { repo, worktree } = mainCheckout('unreadable', '.env\ntop.key\n')
    chmodSync(join(repo, '.env'), 0o000)
    try {
      expect(await copyAndDiff(repo, worktree)).toEqual({
        reported: ['top.key'],
        added: ['top.key'],
      })
    } finally {
      chmodSync(join(repo, '.env'), 0o644)
    }
  })
})
