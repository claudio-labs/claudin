import { describe, expect, test, mock } from 'bun:test'

// buildCombinedMemoryPrompt() composes getAutoMemPath()/getTeamMemPath()
// (./paths.js, ./teamMemPaths.js), the project's git root (../utils/git.js,
// ../bootstrap/state.js), and the .gitignore heuristic
// (isTeamMemLikelyGitIgnored, already unit-tested in teamMemPaths.test.ts).
// All of those are mocked at the module boundary here so this file only
// exercises the wiring/conditional logic that decides whether the
// .gitignore guidance paragraph is included. Real modules are spread first
// since other code transitively imported by teamMemPrompts.js relies on
// unrelated exports (e.g. getSessionId) from these same modules.
const realState = { ...(await import('../bootstrap/state.js')) }
const realGit = { ...(await import('../utils/git.js')) }
const realPaths = { ...(await import('./paths.js')) }
const realTeamMemPaths = { ...(await import('./teamMemPaths.js')) }

async function importFreshTeamMemPrompts(options: {
  autoDir: string
  teamDir: string
  gitRoot: string | null
  likelyIgnored: boolean
}) {
  mock.module('./paths.js', () => ({
    ...realPaths,
    getAutoMemPath: () => options.autoDir,
  }))
  mock.module('./teamMemPaths.js', () => ({
    ...realTeamMemPaths,
    getTeamMemPath: () => options.teamDir,
    isTeamMemLikelyGitIgnored: () => options.likelyIgnored,
  }))
  mock.module('../bootstrap/state.js', () => ({
    ...realState,
    getProjectRoot: () => '/fake/project',
  }))
  mock.module('../utils/git.js', () => ({
    ...realGit,
    findCanonicalGitRoot: () => options.gitRoot,
  }))
  return import(`./teamMemPrompts.js?t=${Date.now()}-${Math.random()}`)
}

describe('buildCombinedMemoryPrompt — .gitignore guidance', () => {
  test('includes the guidance when team memory is project-local and likely gitignored', async () => {
    const { buildCombinedMemoryPrompt } = await importFreshTeamMemPrompts({
      autoDir: '/repo/.claudin/memory/',
      teamDir: '/repo/.claudin/memory/team/',
      gitRoot: '/repo',
      likelyIgnored: true,
    })

    const prompt = buildCombinedMemoryPrompt()

    expect(prompt).toContain('Heads up')
    expect(prompt).toContain('!/.claudin/memory/team/')
  })

  test('omits the guidance when the .gitignore check reports no conflict', async () => {
    const { buildCombinedMemoryPrompt } = await importFreshTeamMemPrompts({
      autoDir: '/repo/.claudin/memory/',
      teamDir: '/repo/.claudin/memory/team/',
      gitRoot: '/repo',
      likelyIgnored: false,
    })

    const prompt = buildCombinedMemoryPrompt()

    expect(prompt).not.toContain('Heads up')
  })

  test('omits the guidance when team memory is not project-local (legacy global path)', async () => {
    const { buildCombinedMemoryPrompt } = await importFreshTeamMemPrompts({
      autoDir: '/home/user/.claudin/projects/x/memory/',
      teamDir: '/home/user/.claudin/projects/x/memory/team/',
      gitRoot: '/repo',
      likelyIgnored: true,
    })

    const prompt = buildCombinedMemoryPrompt()

    expect(prompt).not.toContain('Heads up')
  })

  test('omits the guidance when there is no git root', async () => {
    const { buildCombinedMemoryPrompt } = await importFreshTeamMemPrompts({
      autoDir: '/repo/.claudin/memory/',
      teamDir: '/repo/.claudin/memory/team/',
      gitRoot: null,
      likelyIgnored: true,
    })

    const prompt = buildCombinedMemoryPrompt()

    expect(prompt).not.toContain('Heads up')
  })
})
