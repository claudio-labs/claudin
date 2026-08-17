import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  RULE_MAP_KILLSWITCH,
  RULE_MAP_RELATIVE_PATH,
  describeRuleMapSync,
  syncProjectRuleMap,
} from 'src/memory/instructions/ruleMapAutoSync.js'

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A committed git repo with `count` source files, so `git ls-files` sees them. */
function makeRepo(count = 8, extension = '.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'mapsync-'))
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

afterEach(() => {
  delete process.env[RULE_MAP_KILLSWITCH]
})

describe('syncProjectRuleMap', () => {
  test('writes a map into a project that has none', async () => {
    const root = makeRepo()
    const outcome = await syncProjectRuleMap(root)
    expect(outcome).toEqual({
      status: 'created',
      path: RULE_MAP_RELATIVE_PATH,
    })

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

    writeFileSync(mapPath(root), '# mine, uncommitted\n')
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
    expect(readFileSync(mapPath(root), 'utf8')).toBe('# mine, uncommitted\n')
  })

  test('writes nothing in a directory git does not track', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mapsync-nogit-'))
    writeFileSync(join(root, 'a.ts'), 'x\n')
    const outcome = await syncProjectRuleMap(root)
    expect(outcome.status).toBe('skipped')
    expect(outcome).not.toHaveProperty('path')
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

describe('describeRuleMapSync', () => {
  test('announces a write and names the killswitch', () => {
    const notice = describeRuleMapSync({
      status: 'created',
      path: RULE_MAP_RELATIVE_PATH,
    })
    expect(notice).toContain(RULE_MAP_RELATIVE_PATH)
    expect(notice).toContain(RULE_MAP_KILLSWITCH)
  })

  test('says nothing when nothing was written', () => {
    expect(
      describeRuleMapSync({ status: 'skipped', reason: 'already current' }),
    ).toBeNull()
  })
})
