import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  RULE_MAP_KILLSWITCH,
  RULE_MAP_RELATIVE_PATH,
  describeRuleMapNotice,
  setAsideHealerOnlyRuleMap,
  syncProjectRuleMap,
} from 'src/memory/instructions/ruleMapAutoSync.js'

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

const roots: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** A committed git repo with `count` source files, so `git ls-files` sees them. */
function makeRepo(count = 8, extension = '.ts'): string {
  const root = tempDir('mapsync-')
  run(root, ['init', '-q'])
  run(root, ['config', 'user.email', 'test@example.com'])
  run(root, ['config', 'user.name', 'Test'])
  mkdirSync(join(root, 'src', 'core'), { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, 'src', 'core', `f${i}${extension}`), 'x\n')
  }
  run(root, ['add', '-A'])
  run(root, ['commit', '-qm', 'init'])
  return root
}

function mapPath(root: string): string {
  return join(root, RULE_MAP_RELATIVE_PATH)
}

// An ambient killswitch would turn every test here into a skip; the one test
// that sets it relies on this to clear it again.
const savedKillswitch = process.env[RULE_MAP_KILLSWITCH]
beforeEach(() => {
  delete process.env[RULE_MAP_KILLSWITCH]
})
afterAll(() => {
  if (savedKillswitch === undefined) delete process.env[RULE_MAP_KILLSWITCH]
  else process.env[RULE_MAP_KILLSWITCH] = savedKillswitch
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Adds `count` tracked, committed files under `src/<dir>`, enough to be drawn. */
function grow(root: string, dir: string, count = 40): void {
  mkdirSync(join(root, 'src', dir), { recursive: true })
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, 'src', dir, `g${i}.ts`), 'x\n')
  }
  run(root, ['add', 'src'])
  run(root, ['commit', '-qm', dir])
}

describe('syncProjectRuleMap', () => {
  test('writes a map into a project that has none', async () => {
    const root = makeRepo()
    const outcome = await syncProjectRuleMap(root)
    expect(outcome).toMatchObject({
      status: 'created',
      path: RULE_MAP_RELATIVE_PATH,
    })
    expect(outcome).toHaveProperty('changes', [
      { path: 'src/', from: null, to: 8 },
      { path: 'src/core/', from: null, to: 8 },
    ])

    const written = readFileSync(mapPath(root), 'utf8')
    expect(written).toContain('core/ (8)')
    // Never unconditional: an unscoped rule bills every turn of every session.
    expect(written).toMatch(/^---\npaths:/)
  })

  test('is a no-op the second time, so a session start costs no write', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    const first = readFileSync(mapPath(root), 'utf8')

    const second = await syncProjectRuleMap(root)
    expect(second).toEqual({ status: 'skipped', reason: 'already current' })
    expect(readFileSync(mapPath(root), 'utf8')).toBe(first)
  })

  test('still heals a map it wrote that nobody has committed yet', async () => {
    // The first sync leaves the file untracked. Reading `??` as "the user is
    // editing" would freeze every generated map at its birth numbers.
    const root = makeRepo()
    await syncProjectRuleMap(root)

    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow'])

    expect((await syncProjectRuleMap(root)).status).toBe('healed')
    expect(readFileSync(mapPath(root), 'utf8')).toContain('grown/ (40)')
  })

  test('heals a committed map once the tree has really moved', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'grow'])

    const outcome = await syncProjectRuleMap(root)
    expect(outcome.status).toBe('healed')
    expect(readFileSync(mapPath(root), 'utf8')).toContain('grown/ (40)')
  })

  test('keeps the annotations a human wrote', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    const annotated = readFileSync(mapPath(root), 'utf8').replace(
      '← TODO',
      '← the core',
    )
    writeFileSync(mapPath(root), annotated)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'annotate'])

    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'grow'])

    await syncProjectRuleMap(root)
    expect(readFileSync(mapPath(root), 'utf8')).toContain('← the core')
  })

  test('will not touch a map the user is in the middle of editing', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    const edited = readFileSync(mapPath(root), 'utf8').replace(
      '# Module Map',
      '# Module Map\n\nA note of mine, uncommitted.',
    )
    writeFileSync(mapPath(root), edited)
    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow'])

    const outcome = await syncProjectRuleMap(root)
    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'uncommitted changes',
    })
    expect(readFileSync(mapPath(root), 'utf8')).toBe(edited)
  })

  test('will not touch an annotation the user has not committed yet', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    const annotated = readFileSync(mapPath(root), 'utf8').replace(
      '← TODO',
      '← mine',
    )
    writeFileSync(mapPath(root), annotated)
    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow'])

    expect(await syncProjectRuleMap(root)).toEqual({
      status: 'skipped',
      reason: 'uncommitted changes',
    })
    expect(readFileSync(mapPath(root), 'utf8')).toBe(annotated)
  })

  test('heals again a generated map whose only uncommitted change is its own last heal', async () => {
    // Without this the first heal of a session froze the map: the write left
    // the file modified, and modified read as "the user is editing it".
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    for (const dir of ['grown', 'more']) {
      mkdirSync(join(root, 'src', dir), { recursive: true })
      for (let i = 0; i < 40; i++) {
        writeFileSync(join(root, 'src', dir, `g${i}.ts`), 'x\n')
      }
      run(root, ['add', 'src'])
      run(root, ['commit', '-qm', dir])
      expect((await syncProjectRuleMap(root)).status).toBe('healed')
    }
    expect(readFileSync(mapPath(root), 'utf8')).toContain('more/ (40)')
  })

  test('heals again a hand-written map whose only uncommitted change is a count', async () => {
    const root = makeRepo()
    const handWritten = [
      '```',
      'src/',
      '└── core/ (2)                    ← the core',
      '```',
      '',
    ].join('\n')
    mkdirSync(join(root, '.claudin', 'rules'), { recursive: true })
    writeFileSync(mapPath(root), handWritten)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    expect((await syncProjectRuleMap(root)).status).toBe('healed')
    for (let i = 8; i < 40; i++) {
      writeFileSync(join(root, 'src', 'core', `f${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow'])

    const outcome = await syncProjectRuleMap(root)
    expect(outcome).toMatchObject({
      status: 'healed',
      changes: [{ path: 'src/core/', from: 8, to: 40 }],
    })
    expect(readFileSync(mapPath(root), 'utf8')).toContain('core/ (40)')
  })

  test('treats a staged, never-committed map as the baseline', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])

    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    expect((await syncProjectRuleMap(root)).status).toBe('healed')
    expect((await syncProjectRuleMap(root)).status).toBe('skipped')

    mkdirSync(join(root, 'src', 'more'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'more', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    expect((await syncProjectRuleMap(root)).status).toBe('healed')
  })

  test('heals again when the project is rooted in a subdirectory of the repo', async () => {
    // `git show HEAD:<path>` reads the path from the top of the repo, so a
    // project in `repo/pkg` never found its committed map and froze again.
    const repo = makeRepo()
    const root = join(repo, 'pkg')
    mkdirSync(join(root, 'src', 'core'), { recursive: true })
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(root, 'src', 'core', `p${i}.ts`), 'x\n')
    }
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'pkg'])
    expect((await syncProjectRuleMap(root)).status).toBe('created')
    run(repo, ['add', '-A'])
    run(repo, ['commit', '-qm', 'map'])

    for (const dir of ['grown', 'more']) {
      mkdirSync(join(root, 'src', dir), { recursive: true })
      for (let i = 0; i < 40; i++) {
        writeFileSync(join(root, 'src', dir, `g${i}.ts`), 'x\n')
      }
      run(repo, ['add', '-A', 'pkg/src'])
      run(repo, ['commit', '-qm', dir])
      expect((await syncProjectRuleMap(root)).status).toBe('healed')
    }
  })

  test('will not drop a note the user wrote inside the generated tree', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    const noted = readFileSync(mapPath(root), 'utf8').replace(
      '```\n',
      '```\n# start in src/core\n',
    )
    writeFileSync(mapPath(root), noted)
    mkdirSync(join(root, 'src', 'grown'), { recursive: true })
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(root, 'src', 'grown', `g${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow'])

    expect(await syncProjectRuleMap(root)).toEqual({
      status: 'skipped',
      reason: 'uncommitted changes',
    })
    expect(readFileSync(mapPath(root), 'utf8')).toBe(noted)
  })

  test('heals only the numbers of a committed hand-written map', async () => {
    const root = makeRepo()
    const handWritten = [
      '# Map',
      '',
      'Prose a human wrote.',
      '',
      '```',
      'src/',
      '└── core/ (2)                    ← the core',
      '```',
      '',
    ].join('\n')
    mkdirSync(join(root, '.claudin', 'rules'), { recursive: true })
    writeFileSync(mapPath(root), handWritten)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    expect((await syncProjectRuleMap(root)).status).toBe('healed')
    expect(readFileSync(mapPath(root), 'utf8')).toBe(
      handWritten.replace('core/ (2)', 'core/ (8)'),
    )
  })

  test('writes nothing in a directory git does not track', async () => {
    const root = tempDir('mapsync-nogit-')
    writeFileSync(join(root, 'a.ts'), 'x\n')
    expect(await syncProjectRuleMap(root)).toEqual({
      status: 'skipped',
      reason: 'not a git repo',
    })
  })

  test('a repo whose file list cannot be read is an error, so it is retried', async () => {
    // Not "not a git repo": that reason stands until the tree moves, and this
    // one is usually a lock or a half-written index.
    const root = makeRepo()
    writeFileSync(join(root, '.git', 'index'), 'not an index')
    expect(await syncProjectRuleMap(root)).toEqual({ status: 'skipped', reason: 'error' })
  })

  test('will not drop the rest of a note that holds an arrow of its own', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    const noted = readFileSync(mapPath(root), 'utf8').replace(
      /(core\/ \(8\)\s+)← TODO/,
      '$1← the core ← being split, ask first',
    )
    writeFileSync(mapPath(root), noted)
    grow(root, 'grown')

    expect(await syncProjectRuleMap(root)).toEqual({
      status: 'skipped',
      reason: 'uncommitted changes',
    })
    expect(readFileSync(mapPath(root), 'utf8')).toBe(noted)
  })

  test('a committed note with an arrow survives a regenerate whole', async () => {
    const root = makeRepo()
    await syncProjectRuleMap(root)
    const noted = readFileSync(mapPath(root), 'utf8').replace(
      /(core\/ \(8\)\s+)← TODO/,
      '$1← the core ← being split, ask first',
    )
    writeFileSync(mapPath(root), noted)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])
    grow(root, 'grown')

    expect((await syncProjectRuleMap(root)).status).toBe('healed')
    const healed = readFileSync(mapPath(root), 'utf8')
    expect(healed).toContain('← the core ← being split, ask first')
    expect(healed).toContain('grown/ (40)')
  })

  test('a generated map with committed text in its tree heals numbers only, and keeps healing', async () => {
    // Redrawing it would delete the text; leaving the heal modified and then
    // refusing it as "uncommitted" would freeze it. Numbers-only does neither.
    const root = makeRepo()
    await syncProjectRuleMap(root)
    const noted = readFileSync(mapPath(root), 'utf8').replace(
      '```\n',
      '```\n# start in src/core\n',
    )
    writeFileSync(mapPath(root), noted)
    run(root, ['add', '-A'])
    run(root, ['commit', '-qm', 'map'])

    for (let i = 8; i < 40; i++) {
      writeFileSync(join(root, 'src', 'core', `f${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow core'])
    expect((await syncProjectRuleMap(root)).status).toBe('healed')

    for (let i = 40; i < 90; i++) {
      writeFileSync(join(root, 'src', 'core', `f${i}.ts`), 'x\n')
    }
    run(root, ['add', 'src'])
    run(root, ['commit', '-qm', 'grow core again'])
    expect((await syncProjectRuleMap(root)).status).toBe('healed')

    const healed = readFileSync(mapPath(root), 'utf8')
    expect(healed).toContain('# start in src/core')
    expect(healed).toContain('core/ (90)')
  })

  test('writes nothing inside a linked worktree', async () => {
    // A worktree path can canonicalize back to the main checkout, so a write
    // from one lands in somebody else's tree.
    const root = makeRepo()
    const wt = join(root, 'wt')
    run(root, ['worktree', 'add', '-q', '-b', 'side', wt])
    expect(await syncProjectRuleMap(wt)).toEqual({
      status: 'skipped',
      reason: 'worktree',
    })
  })

  test('does nothing at all with the killswitch set', async () => {
    const root = makeRepo()
    process.env[RULE_MAP_KILLSWITCH] = '1'
    expect(await syncProjectRuleMap(root)).toEqual({
      status: 'skipped',
      reason: 'killswitch',
    })
  })

  test('follows the language the repo is written in', async () => {
    const root = makeRepo(8, '.py')
    await syncProjectRuleMap(root)
    const written = readFileSync(mapPath(root), 'utf8')
    expect(written).toContain('- "**/*.py"')
    expect(written).not.toContain('.ts')
  })
})

/** A committed map that the sync has since healed: the tree's only change is ` M <map>`. */
async function healedRepo(): Promise<string> {
  const root = makeRepo()
  await syncProjectRuleMap(root)
  run(root, ['add', '-A'])
  run(root, ['commit', '-qm', 'map'])
  grow(root, 'grown')
  expect((await syncProjectRuleMap(root)).status).toBe('healed')
  return root
}

describe('setAsideHealerOnlyRuleMap', () => {
  test("puts the committed map back when the sync's heal is the only change", async () => {
    const root = await healedRepo()
    const committed = gitOut(root, ['show', 'HEAD:.claudin/rules/search-strategy.md'])

    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(true)
    expect(gitOut(root, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(mapPath(root), 'utf8')).toBe(committed)
  })

  test('runs for a command in a subdirectory of the same checkout', async () => {
    const root = await healedRepo()

    expect(await setAsideHealerOnlyRuleMap(root, join(root, 'src', 'core'))).toBe(true)
  })

  test('runs when the refusal names the map, and not when it names another file', async () => {
    const root = await healedRepo()
    expect(await setAsideHealerOnlyRuleMap(root, root, ['src/core/f0.ts'])).toBe(false)
    expect(await setAsideHealerOnlyRuleMap(root, root, ['.claudin/rules/search-strategy.md'])).toBe(true)
  })

  test('leaves a repository with an operation in progress alone', async () => {
    const root = await healedRepo()
    writeFileSync(join(root, '.git', 'MERGE_HEAD'), `${gitOut(root, ['rev-parse', 'HEAD'])}\n`)

    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(false)
  })

  test('leaves a map the user edited alone', async () => {
    const root = await healedRepo()
    writeFileSync(mapPath(root), `${readFileSync(mapPath(root), 'utf8')}\nA note of mine.\n`)
    const before = readFileSync(mapPath(root), 'utf8')

    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(false)
    expect(readFileSync(mapPath(root), 'utf8')).toBe(before)
  })

  test('leaves a staged map alone', async () => {
    const root = await healedRepo()
    run(root, ['add', RULE_MAP_RELATIVE_PATH])

    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(false)
    expect(gitOut(root, ['status', '--porcelain'])).toContain('M  .claudin/rules/search-strategy.md')
  })

  test('does nothing while another tracked file is dirty too', async () => {
    const root = await healedRepo()
    writeFileSync(join(root, 'src', 'core', 'f0.ts'), 'edited\n')
    const before = readFileSync(mapPath(root), 'utf8')

    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(false)
    expect(readFileSync(mapPath(root), 'utf8')).toBe(before)
  })

  test('does nothing when the command ran in another tree', async () => {
    const root = await healedRepo()
    const elsewhere = tempDir('mapsync-wt-')
    rmSync(elsewhere, { recursive: true, force: true })
    run(root, ['worktree', 'add', '-q', elsewhere])

    expect(await setAsideHealerOnlyRuleMap(root, elsewhere)).toBe(false)
    expect(gitOut(root, ['status', '--porcelain', '--untracked-files=no'])).toContain(
      ' M .claudin/rules/search-strategy.md',
    )
  })

  test('does nothing in a clean tree, outside a repo, or under the killswitch', async () => {
    const clean = makeRepo()
    expect(await setAsideHealerOnlyRuleMap(clean, clean)).toBe(false)
    const notRepo = tempDir('mapsync-plain-')
    expect(await setAsideHealerOnlyRuleMap(notRepo, notRepo)).toBe(false)

    const root = await healedRepo()
    process.env[RULE_MAP_KILLSWITCH] = '1'
    expect(await setAsideHealerOnlyRuleMap(root, root)).toBe(false)
  })
})

describe('describeRuleMapNotice', () => {
  test('announces a first map with the switch that turns it off', () => {
    const notice = describeRuleMapNotice({
      status: 'created',
      path: RULE_MAP_RELATIVE_PATH,
      changes: [{ path: 'src/', from: null, to: 8 }],
    })
    expect(notice).toBe(
      `Navigation map · ${RULE_MAP_RELATIVE_PATH} · created · 1 directory (/map off to turn this off)`,
    )
  })

  test('names what an update moved, capped to one line', () => {
    const notice = describeRuleMapNotice({
      status: 'healed',
      path: RULE_MAP_RELATIVE_PATH,
      changes: [
        { path: 'src/tools/', from: 682, to: 751 },
        { path: 'src/new/', from: null, to: 12 },
        { path: 'src/old/', from: 9, to: null },
        { path: 'src/memory/', from: 70, to: 80 },
      ],
    })
    expect(notice).toBe(
      `Navigation map · ${RULE_MAP_RELATIVE_PATH} · updated · src/tools/ 682→751, src/new/ (new, 12), src/old/ (gone) and 1 more`,
    )
  })
})
