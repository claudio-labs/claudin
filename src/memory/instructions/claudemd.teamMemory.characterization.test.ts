/**
 * The instruction loader as the shipped build runs it, and an `@~/` include.
 *
 * The build turns TEAMMEM on, and `bun test` reads every `feature()` as off, so
 * the team-memory index is never loaded under the plain runner. Run plainly,
 * this file has a single test: it starts a child `bun test --feature=TEAMMEM`
 * on itself, with HOME pointed at a temp directory (Bun reads the home
 * directory once, at startup), and fails with the child's output if any test
 * there fails. In the child the real cases below run.
 */
import { feature } from 'bun:bundle'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, relative, sep } from 'path'
// One line per import: the provenance measure skips import statements.
import { clearMemoryFileCaches, getClaudeMds, getMemoryFiles, type MemoryFileInfo, processMemoryFile, resetGetMemoryFilesCache } from 'src/memory/instructions/claudemd.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { setAllowedSettingSources, setOriginalCwd, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

// `feature()` must be the direct condition of a ternary under `bun test`.
const SHIPPED = feature('TEAMMEM') ? true : false
const CHILD_HOME_VAR = 'CLAUDEMD_CHAR_CHILD_HOME'
// This file sits three levels below the checkout, which holds bunfig.toml.
const CHECKOUT = join(import.meta.dir, '..', '..', '..')

if (!SHIPPED) {
  test('holds in a child run with the TEAMMEM flag on', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-home-')))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TEAMMEM', import.meta.path], {
        cwd: CHECKOUT,
        env: { ...process.env, HOME: home, [CHILD_HOME_VAR]: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      const log = `${out}\n${err}`
      const passed = Number(/(\d+) pass/.exec(log)?.[1] ?? 0)
      const failed = Number(/(\d+) fail/.exec(log)?.[1] ?? -1)
      if (code !== 0 || failed !== 0 || passed === 0) throw new Error(`flagged child run failed (exit ${code}):\n${log.slice(-6000)}`)
      expect(log).not.toMatch(/\d+ skip/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)
} else {
  let root: string
  let memory: string
  let cwd: string
  const local = (path: string): string => relative(root, path)
  const inTree = (path: string): boolean => path.startsWith(root + sep)
  const rows = (files: MemoryFileInfo[]) => files.filter(f => inTree(f.path)).map(f => `${f.type} ${local(f.path)}`)

  function write(path: string, text: string): string {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    return path
  }

  function memoryOn(on: boolean): void {
    process.env.CLAUDIN_DISABLE_AUTO_MEMORY = on ? '0' : '1'
    getAutoMemPath.cache.clear?.()
  }

  async function freshLoad(): Promise<MemoryFileInfo[]> {
    clearMemoryFileCaches()
    return getMemoryFiles()
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-team-')))
    memory = join(root, 'memory')
    cwd = join(root, 'project')
    mkdirSync(memory, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memory
    getManagedFilePath.cache.set(undefined, join(root, 'managed'))
    setOriginalCwd(cwd)
    setProjectRoot(cwd)
    setAllowedSettingSources(['policySettings', 'flagSettings', 'userSettings', 'projectSettings', 'localSettings'])
    resetSettingsCache()
    memoryOn(true)
  })

  afterAll(() => {
    clearMemoryFileCaches()
    resetGetMemoryFilesCache()
    rmSync(root, { recursive: true, force: true })
  })

  describe('the team-memory index (TEAMMEM on)', () => {
    test('the private index, then the team index, come after every instruction file', async () => {
      write(join(cwd, 'AGENTS.md'), 'project\n')
      write(join(memory, 'MEMORY.md'), 'private index\n')
      write(join(memory, 'team', 'MEMORY.md'), '\n## Decisions\n- [Git](decisions/git.md) — why\n\n')

      const files = (await freshLoad()).filter(f => inTree(f.path))

      expect(rows(files)).toEqual(['Project project/AGENTS.md', 'AutoMem memory/MEMORY.md', 'TeamMem memory/team/MEMORY.md'])
      expect(files[2]).toMatchObject({ content: '## Decisions\n- [Git](decisions/git.md) — why', contentDiffersFromDisk: true })
    })

    test('an empty team index still gives an entry; a missing one gives none', async () => {
      write(join(memory, 'team', 'MEMORY.md'), '\n')
      const withEmpty = (await freshLoad()).filter(f => f.type === 'TeamMem')

      rmSync(join(memory, 'team'), { recursive: true })
      const withMissing = (await freshLoad()).filter(f => f.type === 'TeamMem')

      expect(withEmpty.map(f => f.content)).toEqual([''])
      expect(withMissing).toEqual([])
    })

    test('the team index is cut at 200 lines too', async () => {
      write(join(memory, 'team', 'MEMORY.md'), Array.from({ length: 205 }, (_, i) => `- team ${i + 1}`).join('\n'))

      const team = (await freshLoad()).find(f => f.type === 'TeamMem')?.content ?? ''

      expect(team).toContain('- team 200\n')
      expect(team).not.toContain('- team 201')
    })

    test('with auto memory off, there is no team index either', async () => {
      write(join(memory, 'MEMORY.md'), 'private\n')
      write(join(memory, 'team', 'MEMORY.md'), 'team\n')
      memoryOn(false)

      expect((await freshLoad()).filter(f => f.type === 'AutoMem' || f.type === 'TeamMem')).toEqual([])
    })

    test('a team index already reached through an include is not added again', async () => {
      write(join(cwd, 'AGENTS.md'), 'project\n\n@../memory/team/MEMORY.md\n')
      write(join(memory, 'team', 'MEMORY.md'), 'team\n')

      clearMemoryFileCaches()
      const files = await getMemoryFiles(true)

      expect(rows(files)).toEqual(['Project project/AGENTS.md', 'Project memory/team/MEMORY.md'])
    })

    test('getClaudeMds fences the team index in a shared-content tag, under its own label', () => {
      const text = getClaudeMds([{ type: 'TeamMem', path: '/m/team/MEMORY.md', content: '\n- [Git](git.md)\n' }])
      const block = text.slice(text.indexOf('Contents of '))
      const label = /^Contents of \/m\/team\/MEMORY\.md \((.+)\):\n\n/.exec(block)?.[1] ?? ''

      expect(block.slice(block.indexOf('):\n\n') + 4)).toBe('<team-memory-content source="shared">\n- [Git](git.md)\n</team-memory-content>')
      for (const fact of [/team memory/, /shared/, /git-tracked/]) expect(label).toMatch(fact)
    })
  })

  describe('@~/ includes', () => {
    test('expand to the home directory', async () => {
      const home = process.env[CHILD_HOME_VAR] ?? ''
      expect(homedir()).toBe(home)
      write(join(home, 'notes', 'from-home.md'), 'from home\n')
      write(join(cwd, 'AGENTS.md'), 'project\n\n@~/notes/from-home.md\n')

      const files = await processMemoryFile(join(cwd, 'AGENTS.md'), 'Project', new Set(), true)

      expect(files.map(f => f.path)).toEqual([join(cwd, 'AGENTS.md'), join(home, 'notes', 'from-home.md')])
    })
  })
}
