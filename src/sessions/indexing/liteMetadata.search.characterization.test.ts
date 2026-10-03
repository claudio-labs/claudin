// Characterization of `sessions/liteMetadata`, part four: finding sessions by
// title. `/resume <title>`, `--resume <title>`, the `/resume` typeahead and
// `/branch` naming call it. Transcripts are real files; the worktree case uses
// a real git repository isolated from the user's configuration.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { setOriginalCwd } from 'src/platform/bootstrap/state.js'
import { envSnapshot, type EnvSnapshot } from 'src/sessions/__testutils__/lifecycleHarness.js'
import { getProjectDir, searchSessionsByCustomTitle } from 'src/sessions/sessionStorage.js'
import { chat, meta, uid, useLiteWorld } from 'src/sessions/indexing/__testutils__/liteWorld.js'

const world = useLiteWorld()

let gitEnv: EnvSnapshot
beforeEach(() => {
  gitEnv = envSnapshot(['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES'])
  process.env.HOME = world.root
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CEILING_DIRECTORIES = tmpdir()
})
afterEach(() => gitEnv.restore())

type Titled = { n: number; title?: string; ai?: string; mtime: number; hidden?: boolean }

/** Session `uid(n, 'feedface')`, with the given title and modification time (seconds past 1_790_000_000). */
function session({ n, title, ai, mtime, hidden }: Titled, dir?: string): string {
  const id = uid(n, 'feedface')
  const lines = [
    ...chat([{ kind: 'user', content: `prompt ${n}`, extra: hidden ? { isSidechain: true } : {} }], { sessionId: id }),
    ...(title === undefined ? [] : [meta.title(title, id)]),
    ...(ai === undefined ? [] : [meta.aiTitle(ai, id)]),
  ]
  world.write(id, lines, { mtime: 1_790_000_000 + mtime, dir })
  return id
}

const ids = (logs: { sessionId?: string }[]) => logs.map(l => Number(l.sessionId!.slice(-3)))

describe('searchSessionsByCustomTitle outside a repository', () => {
  function sessions() {
    session({ n: 1, title: 'Parser rewrite', mtime: 10 })
    session({ n: 2, title: '  PARSER fixes  ', mtime: 30 })
    session({ n: 3, ai: 'Parser cleanup (guessed)', mtime: 20 })
    session({ n: 4, mtime: 40 })
    session({ n: 5, title: 'Parser hidden', mtime: 50, hidden: true })
    session({ n: 6, title: 'Lexer', mtime: 60 })
  }

  const queries: Array<[string, { limit?: number; exact?: boolean } | undefined, number[]]> = [
    ['parser', undefined, [2, 3, 1]],
    ['  ParSer  ', undefined, [2, 3, 1]],
    ['parser fixes', { exact: true }, [2]],
    ['Parser', { exact: true }, []],
    ['parser cleanup (guessed)', { exact: true }, [3]],
    ['parser', { limit: 2 }, [2, 3]],
    ['parser', { limit: 0 }, [2, 3, 1]],
    ['', undefined, [6, 2, 3, 1]],
    ['nothing like it', undefined, []],
  ]
  for (const [query, options, expected] of queries) {
    test(`"${query}" ${JSON.stringify(options ?? {})} finds ${JSON.stringify(expected)}`, async () => {
      sessions()
      expect(ids(await searchSessionsByCustomTitle(query, options))).toEqual(expected)
    })
  }

  test('a match is an enriched record of the session', async () => {
    sessions()
    const [match] = await searchSessionsByCustomTitle('lexer', { exact: true })
    expect(match).toMatchObject({ customTitle: 'Lexer', firstPrompt: 'prompt 6', isLite: false, projectPath: '/home/dev/shop', messages: [] })
  })

  test('an empty project finds nothing', async () => {
    expect(await searchSessionsByCustomTitle('anything')).toEqual([])
  })
})

describe('searchSessionsByCustomTitle in a repository with worktrees', () => {
  function git(cwd: string, ...args: string[]) {
    const run = Bun.spawnSync(['git', ...args], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.test' },
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  }

  test("titles in every worktree's project are searched, and other projects are not", async () => {
    const repo = world.project
    const linked = join(world.root, 'work', 'shop-hotfix')
    git(repo, 'init', '--quiet', '--initial-branch=main')
    git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'start')
    git(repo, 'worktree', 'add', '--quiet', '-b', 'hotfix', linked)

    const projects = join(world.root, 'home', 'projects')
    mkdirSync(projects, { recursive: true })
    session({ n: 1, title: 'Release in main', mtime: 10 })
    session({ n: 2, title: 'Release in hotfix', mtime: 20 }, getProjectDir(linked))
    session({ n: 3, title: 'Release elsewhere', mtime: 30 }, join(projects, '-somewhere-else'))

    setOriginalCwd(repo)
    const found = await searchSessionsByCustomTitle('release')
    expect(ids(found)).toEqual([2, 1])
    expect(found.map(l => dirname(l.fullPath!))).toEqual([getProjectDir(linked), getProjectDir(repo)])
  })
})
