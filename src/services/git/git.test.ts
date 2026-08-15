import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { dedupeCanonicalRoots, findNestedGitRoots } from 'src/services/git/git.js'

describe('dedupeCanonicalRoots', () => {
  test('drops nulls and keeps first occurrence order', () => {
    expect(
      dedupeCanonicalRoots(['/a', null, '/b', '/a', null, '/c']),
    ).toEqual(['/a', '/b', '/c'])
  })

  test('returns [] when every root is null', () => {
    expect(dedupeCanonicalRoots([null, null])).toEqual([])
  })

  test('preserves a single root', () => {
    expect(dedupeCanonicalRoots(['/repo'])).toEqual(['/repo'])
  })
})

describe('findNestedGitRoots', () => {
  const base = mkdtempSync(join(tmpdir(), 'claudin-nested-'))
  const mkRepo = (rel: string, asFile = false): string => {
    const dir = join(base, rel)
    mkdirSync(dir, { recursive: true })
    if (asFile) writeFileSync(join(dir, '.git'), 'gitdir: ../.git/modules/x')
    else mkdirSync(join(dir, '.git'))
    return dir
  }

  // Two sibling repos at depth 1, one nested at depth 3, one submodule-style
  // (.git file), plus repos buried in skipped/hidden dirs that must NOT appear.
  const repoA = mkRepo('aargau-app')
  const repoB = mkRepo('business')
  const repoC = mkRepo('services/pkg/worker')
  const repoSub = mkRepo('vendored', true)
  mkRepo('node_modules/dep') // skipped: noise dir
  mkRepo('.hidden/secret') // skipped: dot-dir
  mkdirSync(join(base, 'plain-folder'), { recursive: true }) // no .git

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  test('finds each child repo (incl. nested + .git-file), skipping noise/dot-dirs', async () => {
    const found = await findNestedGitRoots(base)
    const names = new Set(found.map(p => basename(p)))
    expect(names).toEqual(
      new Set(['aargau-app', 'business', 'worker', 'vendored']),
    )
    expect(found).toContain(repoA)
    expect(found).toContain(repoB)
    expect(found).toContain(repoC)
    expect(found).toContain(repoSub)
    // Repos inside node_modules / dot-dirs are never returned.
    expect(found.some(p => p.includes('node_modules'))).toBe(false)
    expect(found.some(p => p.includes('.hidden'))).toBe(false)
  })

  test('does not descend into a repo (no double-listing of a repo subtree)', async () => {
    mkdirSync(join(repoA, 'sub'), { recursive: true })
    mkdirSync(join(repoA, 'sub', '.git')) // a repo inside repoA's tree
    const found = await findNestedGitRoots(base)
    expect(found.some(p => p.endsWith(join('aargau-app', 'sub')))).toBe(false)
  })

  test('respects maxDepth (a repo deeper than the limit is not found)', async () => {
    const deep = await findNestedGitRoots(base, { maxDepth: 1 })
    // services/pkg/worker is at depth 3 → excluded when maxDepth is 1.
    expect(deep.map(p => basename(p))).not.toContain('worker')
    expect(deep.map(p => basename(p))).toContain('aargau-app')
  })

  test('returns [] for a non-existent base', async () => {
    expect(await findNestedGitRoots(join(base, 'nope'))).toEqual([])
  })
})
