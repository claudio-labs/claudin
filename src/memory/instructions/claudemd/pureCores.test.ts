/**
 * The pure decisions behind the session load, driven without a filesystem:
 * which directories the walk visits and which of them skip checked-in files,
 * which sources the setting sources open, and how a rule's globs are anchored.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { ruleGlobsMatch } from 'src/memory/instructions/claudemd/nestedDirectories.js'
import { isWithin, planInstructionWalk, planSessionReads } from 'src/memory/instructions/claudemd/sessionSources.js'
import type { SettingSource } from 'src/platform/settings/constants.js'

const p = (...segments: string[]): string => join('/', ...segments)

describe('planInstructionWalk', () => {
  const cases: Array<{ name: string; cwd: string; gitRoot: string | null; canonicalRoot: string | null; skipped: string[] }> = [
    { name: 'no repository: every ancestor, nothing skipped', cwd: p('w', 'r', 'a'), gitRoot: null, canonicalRoot: null, skipped: [] },
    { name: 'a plain checkout skips nothing', cwd: p('w', 'r', 'a'), gitRoot: p('w', 'r'), canonicalRoot: p('w', 'r'), skipped: [] },
    {
      name: 'a worktree inside its main checkout skips the checkout outside the worktree',
      cwd: p('w', 'r', '.claudin', 'wt', 'f', 'src'),
      gitRoot: p('w', 'r', '.claudin', 'wt', 'f'),
      canonicalRoot: p('w', 'r'),
      skipped: [p('w', 'r'), p('w', 'r', '.claudin'), p('w', 'r', '.claudin', 'wt')],
    },
    { name: 'a worktree beside its checkout skips nothing', cwd: p('w', 'wt'), gitRoot: p('w', 'wt'), canonicalRoot: p('w', 'r'), skipped: [] },
  ]
  test.each(cases)('$name', ({ cwd, gitRoot, canonicalRoot, skipped }) => {
    const stops = planInstructionWalk({ cwd, gitRoot, canonicalRoot })

    expect(stops.at(-1)?.dir).toBe(cwd)
    expect(stops.map(stop => stop.dir)).not.toContain(p())
    expect(stops.filter(stop => stop.skipCheckedIn).map(stop => stop.dir)).toEqual(skipped)
  })

  test('top down, every ancestor of the cwd but the filesystem root', () => {
    expect(planInstructionWalk({ cwd: p('a', 'b', 'c'), gitRoot: null, canonicalRoot: null }).map(s => s.dir)).toEqual([p('a'), p('a', 'b'), p('a', 'b', 'c')])
  })
})

describe('isWithin', () => {
  const cases: Array<[string, string, boolean]> = [
    [p('a', 'b'), p('a'), true],
    [p('a'), p('a'), true],
    [p('ab'), p('a'), false],
    [p('a', '..b'), p('a'), true],
    [p('b'), p('a'), false],
  ]
  test.each(cases)('%s inside %s: %p', (path, dir, inside) => {
    expect(isWithin(path, dir)).toBe(inside)
  })
})

describe('planSessionReads', () => {
  const stop = { dir: p('w', 'r'), skipCheckedIn: false }
  const rows = (sources: SettingSource[], extra: Partial<Parameters<typeof planSessionReads>[0]> = {}) =>
    planSessionReads({
      stops: [stop],
      addedDirectories: [],
      isEnabled: source => sources.includes(source),
      exists: () => false,
      ...extra,
    }).map(read => `${read.type} ${read.kind}`)

  test('the setting sources open the user, project and local rows; managed rows are always read', () => {
    expect(rows([])).toEqual(['Managed file', 'Managed rules'])
    expect(rows(['userSettings'])).toEqual(['Managed file', 'Managed rules', 'User file', 'User rules'])
    expect(rows(['projectSettings'])).toEqual(['Managed file', 'Managed rules', 'Project file', 'Project file', 'Project rules'])
    expect(rows(['localSettings'])).toEqual(['Managed file', 'Managed rules', 'Local file'])
  })

  test('a skipping stop keeps only its local file', () => {
    expect(rows(['projectSettings', 'localSettings'], { stops: [{ ...stop, skipCheckedIn: true }] })).toEqual(['Managed file', 'Managed rules', 'Local file'])
  })

  test('an added directory gives its project rows whatever the sources say, never a local file', () => {
    const reads = planSessionReads({ stops: [], addedDirectories: [p('e')], isEnabled: () => false, exists: () => false })

    expect(reads.slice(2).map(read => read.path)).toEqual([p('e', 'CLAUDE.md'), p('e', '.claudin', 'CLAUDE.md'), p('e', '.claudin', 'rules')])
  })

  test('the root instruction file follows the existence check', () => {
    const reads = planSessionReads({ stops: [stop], addedDirectories: [], isEnabled: () => true, exists: path => path.endsWith('AGENTS.md') })

    expect(reads.map(read => read.path)).toContain(p('w', 'r', 'AGENTS.md'))
  })
})

describe('ruleGlobsMatch', () => {
  const anchor = p('proj')
  const cases: Array<[string, string[], string, boolean]> = [
    ['a file below a scoped directory', ['src/api'], p('proj', 'src', 'api', 'x.ts'), true],
    ['a sibling directory sharing the prefix', ['src/api'], p('proj', 'src', 'apix', 'x.ts'), false],
    ['a basename glob at any depth', ['*.test.ts'], p('proj', 'a', 'b', 'c.test.ts'), true],
    ['a target outside the anchor', ['src/api'], p('other', 'src', 'api', 'x.ts'), false],
    ['the anchor itself', ['**/*'], anchor, false],
    ['a relative target, as written', ['src/api'], join('src', 'api', 'x.ts'), true],
    ['a directory whose name starts with two dots is inside', ['..cache'], p('proj', '..cache', 'x'), true],
  ]
  test.each(cases)('%s', (_name, globs, target, matched) => {
    expect(ruleGlobsMatch(globs, target, anchor)).toBe(matched)
  })
})
