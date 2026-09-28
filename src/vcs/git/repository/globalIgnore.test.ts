import { afterAll, afterEach, beforeAll, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import * as os from 'os'
import { join } from 'path'
import { type IsolatedGitEnv, isolateGitEnv } from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import {
  addFileGlobRuleToGitignore,
  chooseGlobalExcludesFile,
  getGlobalGitignorePath,
  resolveGlobalExcludesFile,
  withRule,
} from 'src/vcs/git/repository/globalIgnore.js'
import { isPathGitignored } from 'src/vcs/git/repository/ignoreCheck.js'

describe('withRule', () => {
  test('the rule counts as present only as a whole line', () => {
    expect(withRule('**/foo.json.bak\n', '**/foo.json')).toBe('**/foo.json.bak\n\n**/foo.json\n')
    expect(withRule('# was **/foo.json\n', '**/foo.json')).toBe('# was **/foo.json\n\n**/foo.json\n')
    expect(withRule('*.swp\n**/foo.json\n', '**/foo.json')).toBeNull()
  })

  test('a line that ends in CR or trailing spaces still holds the rule', () => {
    expect(withRule('*.swp\r\n**/foo.json\r\n', '**/foo.json')).toBeNull()
    expect(withRule('**/foo.json  \n', '**/foo.json')).toBeNull()
  })
})

describe('chooseGlobalExcludesFile', () => {
  const fallback = '/home/someone/.config/git/ignore'

  test('core.excludesFile first, then $XDG_CONFIG_HOME/git/ignore, then the default', () => {
    expect(chooseGlobalExcludesFile({ configured: '/etc/ignores', xdgConfigHome: '/x', fallback })).toBe(
      '/etc/ignores',
    )
    expect(chooseGlobalExcludesFile({ configured: '', xdgConfigHome: '/x', fallback })).toBe(
      '/x/git/ignore',
    )
    expect(chooseGlobalExcludesFile({ configured: '', xdgConfigHome: '', fallback })).toBe(fallback)
  })

  test('a relative core.excludesFile names no single file; a relative XDG_CONFIG_HOME is passed over', () => {
    expect(
      chooseGlobalExcludesFile({ configured: '.gitignore_global', xdgConfigHome: '/x', fallback }),
    ).toBeNull()
    expect(chooseGlobalExcludesFile({ configured: '', xdgConfigHome: 'rel', fallback })).toBe(fallback)
  })
})

describe('against real git, with the home directory redirected', () => {
  const scratch = new ScratchGit()
  let home = ''
  let env: IsolatedGitEnv
  let homeSpy: Mock<typeof os.homedir>

  beforeAll(() => {
    home = scratch.tempDir('ignore-home')
    env = isolateGitEnv(home)
    homeSpy = spyOn(os, 'homedir').mockReturnValue(home)
    if (getGlobalGitignorePath() !== join(home, '.config', 'git', 'ignore')) {
      throw new Error('home redirection did not take effect; refusing to write a global ignore file')
    }
  })

  afterEach(() => {
    env.set('XDG_CONFIG_HOME', undefined)
    env.set('GIT_CONFIG_GLOBAL', '/dev/null')
    rmSync(join(home, '.config'), { recursive: true, force: true })
  })

  afterAll(() => {
    homeSpy.mockRestore()
    env.restore()
    scratch.cleanup()
  })

  const defaultIgnore = (): string => join(home, '.config', 'git', 'ignore')
  const globalConfigWith = (body: string): string =>
    scratch.put(scratch.tempDir('gitconfig'), 'config', body)

  describe('resolveGlobalExcludesFile', () => {
    test("reads core.excludesFile from the user's global config, ~ expanded", async () => {
      env.set('GIT_CONFIG_GLOBAL', globalConfigWith('[core]\n\texcludesFile = ~/my-ignores\n'))
      expect(await resolveGlobalExcludesFile(scratch.repo('from-global'))).toBe(join(home, 'my-ignores'))
    })

    test("never reads the repository's own config, which a clone controls", async () => {
      const repo = scratch.repo('from-repo')
      scratch.run(repo, 'config', 'core.excludesFile', join(repo, 'hijacked'))
      expect(await resolveGlobalExcludesFile(repo)).toBe(defaultIgnore())
    })

    test('XDG_CONFIG_HOME comes before the default', async () => {
      const xdg = scratch.tempDir('xdg')
      env.set('XDG_CONFIG_HOME', xdg)
      expect(await resolveGlobalExcludesFile(scratch.repo('from-xdg'))).toBe(join(xdg, 'git', 'ignore'))
    })
  })

  describe('addFileGlobRuleToGitignore', () => {
    test('with XDG_CONFIG_HOME set, the rule lands in the file git reads', async () => {
      const xdg = scratch.tempDir('xdg-write')
      env.set('XDG_CONFIG_HOME', xdg)
      const repo = scratch.repo('xdg-write')
      await addFileGlobRuleToGitignore('secret.env', repo)
      expect(readFileSync(join(xdg, 'git', 'ignore'), 'utf8')).toBe('**/secret.env\n')
      expect(existsSync(join(home, '.config'))).toBe(false)
      expect(await isPathGitignored('deep/secret.env', repo)).toBe(true)
    })

    test("with core.excludesFile in the user's global config, the rule lands in that file", async () => {
      const target = join(scratch.tempDir('custom'), 'ignores')
      env.set('GIT_CONFIG_GLOBAL', globalConfigWith(`[core]\n\texcludesFile = ${target}\n`))
      const repo = scratch.repo('custom-write')
      await addFileGlobRuleToGitignore('cache.bin', repo)
      expect(readFileSync(target, 'utf8')).toBe('**/cache.bin\n')
      expect(await isPathGitignored('cache.bin', repo)).toBe(true)
    })

    test("a repository's own core.excludesFile is never the file written", async () => {
      const repo = scratch.repo('hijack')
      const hijacked = join(repo, 'hijacked-ignore')
      scratch.run(repo, 'config', 'core.excludesFile', hijacked)
      await addFileGlobRuleToGitignore('token.txt', repo)
      expect(existsSync(hijacked)).toBe(false)
      expect(readFileSync(defaultIgnore(), 'utf8')).toBe('**/token.txt\n')
    })

    test('a rule already in the file only as part of a longer line does not count', async () => {
      const target = scratch.put(scratch.tempDir('substring'), 'ignores', '**/foo.json.bak\n')
      env.set('GIT_CONFIG_GLOBAL', globalConfigWith(`[core]\n\texcludesFile = ${target}\n`))
      const repo = scratch.repo('substring-write')
      await addFileGlobRuleToGitignore('foo.json', repo)
      expect(readFileSync(target, 'utf8')).toBe('**/foo.json.bak\n\n**/foo.json\n')
    })

    test('a directory is judged by a file inside it, so contents already ignored add nothing', async () => {
      // `plans/?*` ignores every name inside plans/, but not the path `plans/` itself.
      const repo = scratch.repo('contents-ignored')
      scratch.put(repo, '.gitignore', 'plans/?*\n')
      await addFileGlobRuleToGitignore('plans/', repo)
      expect(existsSync(join(home, '.config'))).toBe(false)
    })
  })
})
