/**
 * permissions/filePaths: the working directories and case folding.
 *
 * Driven through the `src/permissions/filePermissions.js` barrel, with real
 * directories and symlinks under a fresh temp root per test.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  allWorkingDirectories,
  normalizeCaseForComparison,
  pathInAllowedWorkingPath,
  pathInWorkingPath,
} from 'src/permissions/filePermissions.js'
import {
  openLab,
  permissionContext,
  type Lab,
} from 'src/permissions/__testutils__/filePathsLab.js'

let lab: Lab
beforeEach(() => {
  lab = openLab()
})
afterEach(() => {
  lab.close()
})

describe('normalizeCaseForComparison', () => {
  // Each input on the left folds to the text on the right of the arrow.
  const FOLDS = String.raw`
    /Repo/.CLAUDIN/Settings.Local.JSON => /repo/.claudin/settings.local.json
    C:\Users\ME\Proj => c:\users\me\proj
    already/lower => already/lower
  `
  const pairs = FOLDS.trim().split('\n').map(line => line.trim().split(' => '))
  test.each(pairs)('folds %s', (input, folded) => {
    expect(normalizeCaseForComparison(input!)).toBe(folded!)
  })

  // Plain literals, not the raw block: Bun's transpiler escapes non-ASCII
  // characters inside template literals, so String.raw would see `\u00c9`.
  test('letters beyond ASCII fold too, and the empty path stays empty', () => {
    const extra = new Map([
      ['/ÉCOLE/Ärger', '/école/ärger'],
      ['', ''],
    ])
    for (const [given, want] of extra) expect(normalizeCaseForComparison(given)).toBe(want)
  })

  test('it folds the same on every platform', () => {
    for (const platform of ['linux', 'macos', 'windows'] as const) {
      lab.pretendPlatform(platform)
      expect(normalizeCaseForComparison('/A/B')).toBe('/a/b')
    }
  })
})

describe('allWorkingDirectories', () => {
  test('is the original cwd alone when no directory was added', () => {
    expect([...allWorkingDirectories(permissionContext())]).toEqual([lab.project])
  })

  test('lists the original cwd first, then every added directory in order', () => {
    const one = lab.dir(join(lab.root, 'one'))
    const two = lab.dir(join(lab.root, 'two'))
    const dirs = allWorkingDirectories(permissionContext({ dirs: [one, two] }))
    expect([...dirs]).toEqual([lab.project, one, two])
  })

  test('collapses an added directory that repeats the original cwd', () => {
    const dirs = allWorkingDirectories(permissionContext({ dirs: [lab.project] }))
    expect(dirs.size).toBe(1)
  })

  test('follows the original cwd, not the current cwd', () => {
    const other = lab.dir(join(lab.root, 'moved'))
    lab.moveSession(other)
    expect([...allWorkingDirectories(permissionContext())]).toEqual([other])
  })

  test('keys only matter: added paths are taken as given, not resolved', () => {
    const odd = join(lab.root, 'not-created', '..', 'raw')
    expect(allWorkingDirectories(permissionContext({ dirs: [odd] })).has(odd)).toBe(true)
  })
})

describe('pathInWorkingPath (lexical containment)', () => {
  const W = '/srv/repo'
  const table: Array<[string, string, string, boolean]> = [
    ['the directory itself', '/srv/repo', W, true],
    ['the directory with a trailing slash', '/srv/repo/', W, true],
    ['a child', '/srv/repo/a.ts', W, true],
    ['a deep descendant', '/srv/repo/src/a/b/c.ts', W, true],
    ['a sibling', '/srv/other/a.ts', W, false],
    ['the parent', '/srv', W, false],
    ['a name that only shares the prefix', '/srv/repo-evil/a.ts', W, false],
    ['a dot-dot that climbs out', '/srv/repo/../etc/passwd', W, false],
    ['a dot-dot that stays inside', '/srv/repo/a/../b.ts', W, true],
    ['a dot segment', '/srv/repo/./a.ts', W, true],
    ['doubled slashes', '/srv//repo///a.ts', W, true],
    ['the root as working path', '/anything/at/all', '/', true],
    ['a working path given with dot-dot', '/srv/repo/a.ts', '/srv/x/../repo', true],
    ['a different case (folded)', '/SRV/Repo/A.ts', W, true],
    ['a working path in another case', '/srv/repo/a.ts', '/SRV/REPO', true],
    ['macOS /private/tmp onto /tmp', '/private/tmp/w/a.ts', '/tmp/w', true],
    ['macOS /tmp onto /private/tmp', '/tmp/w/a.ts', '/private/tmp/w', true],
    ['macOS /private/tmp itself onto /tmp', '/private/tmp', '/tmp', true],
    ['macOS /private/var/ onto /var/', '/private/var/f/a.ts', '/var/f', true],
    ['/private/var with no slash is not mapped', '/private/var', '/var', false],
    ['/private/tmpx is not /tmp', '/private/tmpx/a.ts', '/tmp', false],
    ['/private/varx is not /var', '/private/varx/a.ts', '/var', false],
  ]
  for (const [name, path, workingPath, inside] of table) {
    test(`${name}: ${inside ? 'inside' : 'outside'}`, () => {
      expect(pathInWorkingPath(path, workingPath)).toBe(inside)
    })
  }

  test('a relative path is taken from the current cwd', () => {
    const sub = lab.dir(join(lab.root, 'cur'))
    lab.moveSession(sub)
    expect(pathInWorkingPath('src/a.ts', sub)).toBe(true)
    expect(pathInWorkingPath('../elsewhere/a.ts', sub)).toBe(false)
    expect(pathInWorkingPath('a.ts', lab.outside)).toBe(false)
  })

  test('a relative working path is taken from the current cwd as well', () => {
    expect(pathInWorkingPath(join(lab.project, 'pkg', 'a.ts'), 'pkg')).toBe(true)
  })

  test('~ expands to the home directory on both sides', () => {
    const home = homedir()
    expect(pathInWorkingPath('~/proj/a.ts', join(home, 'proj'))).toBe(true)
    expect(pathInWorkingPath(join(home, 'proj', 'a.ts'), '~/proj')).toBe(true)
    expect(pathInWorkingPath('~', home)).toBe(true)
    expect(pathInWorkingPath('~/../x', home)).toBe(false)
  })

  test('~user is not expanded: it is a relative name under the cwd', () => {
    expect(pathInWorkingPath('~root/.ssh/id_rsa', lab.project)).toBe(true)
  })

  test('symlinks are not followed', () => {
    const link = lab.link(join(lab.project, 'out'), lab.outside)
    expect(pathInWorkingPath(join(link, 'secret'), lab.project)).toBe(true)
  })
})

describe('pathInAllowedWorkingPath (symlink-aware)', () => {
  test('a file in the original cwd is allowed', () => {
    const f = lab.file(join(lab.project, 'a.ts'))
    expect(pathInAllowedWorkingPath(f, permissionContext())).toBe(true)
  })

  test('a file in an added directory is allowed', () => {
    const extra = lab.dir(join(lab.root, 'extra'))
    const f = lab.file(join(extra, 'deep', 'b.ts'))
    expect(pathInAllowedWorkingPath(f, permissionContext({ dirs: [extra] }))).toBe(true)
  })

  test('a file outside every working directory is refused', () => {
    const extra = lab.dir(join(lab.root, 'extra'))
    const f = lab.file(join(lab.outside, 'b.ts'))
    expect(pathInAllowedWorkingPath(f, permissionContext({ dirs: [extra] }))).toBe(false)
  })

  test('a file that does not exist yet is judged by where it would land', () => {
    expect(pathInAllowedWorkingPath(join(lab.project, 'new', 'c.ts'), permissionContext())).toBe(true)
    expect(pathInAllowedWorkingPath(join(lab.outside, 'new.ts'), permissionContext())).toBe(false)
  })

  test('a dot-dot that climbs out of the working directory is refused', () => {
    const p = join(lab.project, 'src', '..', '..', 'elsewhere', 'x.ts')
    expect(pathInAllowedWorkingPath(p, permissionContext())).toBe(false)
  })

  const escapes: Array<[string, (l: Lab) => string]> = [
    [
      'a file symlink to a file outside',
      l => l.link(join(l.project, 'innocent.txt'), l.file(join(l.outside, 'secret.txt'))),
    ],
    [
      'a dangling file symlink to a path outside',
      l => l.link(join(l.project, 'later.txt'), join(l.outside, 'not-yet.txt')),
    ],
    [
      'a new file under a directory symlink that leaves',
      l => join(l.link(join(l.project, 'data'), l.outside), 'new.txt'),
    ],
    [
      'an existing file under a directory symlink that leaves',
      l => {
        l.file(join(l.outside, 'cfg.json'))
        return join(l.link(join(l.project, 'data'), l.outside), 'cfg.json')
      },
    ],
    [
      'a chain of two links whose last hop leaves',
      l => {
        const target = l.file(join(l.outside, 'end.txt'))
        const hop = l.link(join(l.project, 'hop'), target)
        return l.link(join(l.project, 'start'), hop)
      },
    ],
    [
      'a relative symlink that climbs out',
      l => {
        l.file(join(l.outside, 'rel.txt'))
        return l.link(join(l.project, 'rel'), '../elsewhere/rel.txt')
      },
    ],
  ]
  for (const [name, build] of escapes) {
    test(`refused: ${name}`, () => {
      const p = build(lab)
      expect(pathInAllowedWorkingPath(p, permissionContext())).toBe(false)
    })
  }

  test('a symlink that stays inside the working directory is allowed', () => {
    const target = lab.file(join(lab.project, 'real', 'x.ts'))
    const p = lab.link(join(lab.project, 'alias.ts'), target)
    expect(pathInAllowedWorkingPath(p, permissionContext())).toBe(true)
  })

  test('a symlink from outside into the working directory is refused', () => {
    // The link itself is outside, so its own path fails even though the
    // target is inside: every form of the path must be inside.
    const target = lab.file(join(lab.project, 'x.ts'))
    const p = lab.link(join(lab.outside, 'into.ts'), target)
    expect(pathInAllowedWorkingPath(p, permissionContext())).toBe(false)
  })

  test('a working directory given as a symlink covers its target too', () => {
    const real = lab.dir(join(lab.root, 'real-dir'))
    const alias = lab.link(join(lab.root, 'alias-dir'), real)
    const f = lab.file(join(real, 'z.ts'))
    const viaAlias = permissionContext({ dirs: [alias] })
    expect(pathInAllowedWorkingPath(f, viaAlias)).toBe(true)
    expect(pathInAllowedWorkingPath(join(alias, 'z.ts'), viaAlias)).toBe(true)
  })

  test('a working directory given by its real path does not cover a link to it', () => {
    const real = lab.dir(join(lab.root, 'real-dir'))
    const alias = lab.link(join(lab.root, 'alias-dir'), real)
    lab.file(join(real, 'z.ts'))
    expect(pathInAllowedWorkingPath(join(alias, 'z.ts'), permissionContext({ dirs: [real] }))).toBe(false)
  })

  test('a spelling in another case is allowed when nothing exists there (parity, finding 2)', () => {
    const shouted = lab.project.toUpperCase()
    expect(pathInAllowedWorkingPath(join(shouted, 'new.ts'), permissionContext())).toBe(true)
  })

  test('a supplied list of forms is used instead of resolving the path', () => {
    const escape = lab.link(join(lab.project, 'esc'), lab.file(join(lab.outside, 's')))
    const ctx = permissionContext()
    expect(pathInAllowedWorkingPath(escape, ctx, [escape])).toBe(true)
    const inside = join(lab.project, 'ok.ts')
    expect(pathInAllowedWorkingPath(inside, ctx, [inside, join(lab.outside, 's')])).toBe(false)
  })

  test('~ is expanded before checking', () => {
    const home = homedir()
    const ctx = permissionContext({ dirs: [home] })
    expect(pathInAllowedWorkingPath('~/filepaths-lab-absent-entry', ctx)).toBe(true)
    expect(pathInAllowedWorkingPath('~/filepaths-lab-absent-entry', permissionContext())).toBe(false)
  })
})
