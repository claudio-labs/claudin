import { afterAll, describe, expect, test, mock } from 'bun:test'
import { readFileSync } from 'fs'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

// buildCombinedMemoryPrompt() composes getAutoMemPath()/getTeamMemPath()
// (./paths.js, ./teamMemPaths.js), the project's git root (../utils/git.js,
// ../bootstrap/state.js), and the .gitignore heuristic
// (isTeamMemLikelyGitIgnored, already unit-tested in teamMemPaths.test.ts).
// All of those are mocked at the module boundary here so this file only
// exercises the wiring/conditional logic that decides whether the
// .gitignore guidance paragraph is included. Real modules are spread first
// since other code transitively imported by teamMemPrompts.js relies on
// unrelated exports (e.g. getSessionId) from these same modules.
const realState = { ...(await import('src/platform/bootstrap/state.js')) }
const realGit = { ...(await import('src/vcs/git/git.js')) }
const realPaths = { ...(await import('src/memory/memdir/paths.js')) }
const realTeamMemPaths = { ...(await import('src/memory/memdir/teamMemPaths.js')) }

// Bun's mock.module() is process-global and is NOT reverted by mock.restore().
// importFreshTeamMemPrompts() leaves ./paths.js, ./teamMemPaths.js,
// ../utils/git.js and ../bootstrap/state.js stubbed (findCanonicalGitRoot,
// getProjectRoot, getAutoMemPath, isTeamMemLikelyGitIgnored → fakes), which
// otherwise bleed into sibling files (paths.test.ts, teamMemPaths.test.ts).
// Re-install the real modules once the file finishes.
afterAll(() => {
  mock.module('src/platform/bootstrap/state.js', () => realState)
  mock.module('src/vcs/git/git.js', () => realGit)
  mock.module('./paths.js', () => realPaths)
  mock.module('./teamMemPaths.js', () => realTeamMemPaths)
})

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
  mock.module('src/platform/bootstrap/state.js', () => ({
    ...realState,
    getProjectRoot: () => '/fake/project',
  }))
  mock.module('src/vcs/git/git.js', () => ({
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

describe('the MEMORY.md index line', () => {
  // As shipped: the same lines systemPrompt.legacy.txt (full) and
  // systemPrompt.main.txt (v2) carry. Until the empty-index note, this was the
  // text a project with no memory at all got too.
  const FULL_INDEX_LINE =
    'Only the two `MEMORY.md` indexes are in context; a memory file is read when you follow its index line. A memory whose frontmatter has `paths:` (same syntax and semantics as a rule in `.claudin/rules/`, relative to the project root) is also attached automatically the first time a Read touches a matching file — give one to a bug or doc memory tied to specific files.'
  const LEAN_INDEX_LINE =
    "Only the two `MEMORY.md` indexes are in context. After writing a memory, add `- [Title](file.md) — hook` (under ~150 chars) to its directory's index, a categorized team memory under its `## Decisions / ## Bugs / ## Docs` section with the subdirectory in the link; lines past 200 are truncated. A memory with `paths:` in its frontmatter (rule syntax, relative to the project root) is attached the first time a Read touches a matching file. Update a memory rather than duplicating it, skip what the code, git history or this conversation already hold, and NEVER put secrets in team memory."

  const FIXED_DIRS = {
    autoDir: '/repo/.claudin/memory/',
    teamDir: '/repo/.claudin/memory/team/',
    gitRoot: null,
    likelyIgnored: false,
  }

  test('pins the shipped index line of both prompts', async () => {
    const m = await importFreshTeamMemPrompts(FIXED_DIRS)

    expect(m.buildCombinedMemoryPrompt().split('\n')).toContain(FULL_INDEX_LINE)
    expect(m.buildLeanCombinedMemoryPrompt().split('\n')).toContain(LEAN_INDEX_LINE)
  })

  const NOTE = 'Both are empty — nothing is saved yet.'
  // The note goes right after the sentence saying only the indexes are in
  // context; each anchor occurs once in its prompt.
  const FULL_ANCHOR = 'a memory file is read when you follow its index line.'
  const LEAN_ANCHOR = 'Only the two `MEMORY.md` indexes are in context.'

  // What getMemoryFiles() holds in each state: an absent index has no entry,
  // an empty or whitespace-only one an entry with nothing in it. The project's
  // own instructions are loaded either way and must not count.
  type Loaded = Pick<MemoryFileInfo, 'type' | 'content'>
  const PROJECT: Loaded = { type: 'Project', content: '# AGENTS.md\n\nUse bun.' }
  const EMPTY_STATES: Record<string, Loaded[]> = {
    'both indexes absent': [PROJECT],
    'both indexes empty': [
      PROJECT,
      { type: 'AutoMem', content: '' },
      { type: 'TeamMem', content: '' },
    ],
    'one index absent, the other whitespace only': [
      PROJECT,
      { type: 'TeamMem', content: ' \n\t' },
    ],
  }
  const ONE_PRESENT: Record<string, Loaded[]> = {
    'the private index': [
      PROJECT,
      { type: 'AutoMem', content: '- [Prefers tabs](prefers-tabs.md) — style' },
    ],
    'the team index': [
      { type: 'AutoMem', content: '' },
      { type: 'TeamMem', content: '## Decisions\n- [Git is the sync](decisions/git.md) — why' },
    ],
  }

  /** Both prompts as loadMemoryPrompt builds them from `loaded`, and as shipped. */
  async function render(loaded: Loaded[]) {
    const m = await importFreshTeamMemPrompts(FIXED_DIRS)
    const { areMemoryIndexesEmpty } = await import('src/memory/memdir/memdir.js')
    const indexesEmpty = areMemoryIndexesEmpty(loaded)
    return {
      full: m.buildCombinedMemoryPrompt(undefined, indexesEmpty),
      lean: m.buildLeanCombinedMemoryPrompt(undefined, indexesEmpty),
      shippedFull: m.buildCombinedMemoryPrompt(),
      shippedLean: m.buildLeanCombinedMemoryPrompt(),
    }
  }

  for (const [state, loaded] of Object.entries(EMPTY_STATES)) {
    test(`${state}: says so once, right after the index sentence`, async () => {
      const r = await render(loaded)

      expect(r.full).toBe(r.shippedFull.replace(FULL_ANCHOR, `${FULL_ANCHOR} ${NOTE}`))
      expect(r.lean).toBe(r.shippedLean.replace(LEAN_ANCHOR, `${LEAN_ANCHOR} ${NOTE}`))
      for (const text of [r.full, r.lean]) {
        expect(text.split(NOTE)).toHaveLength(2)
        // The private-only prompt has its own "currently empty" line
        // (memdir.ts); the model is never told twice.
        expect(text).not.toContain('currently empty')
      }
    })
  }

  for (const [present, loaded] of Object.entries(ONE_PRESENT)) {
    test(`${present} holds entries: the text is exactly the shipped one`, async () => {
      const r = await render(loaded)

      expect(r.full).toBe(r.shippedFull)
      expect(r.lean).toBe(r.shippedLean)
      expect(r.full.split('\n')).toContain(FULL_INDEX_LINE)
      expect(r.lean.split('\n')).toContain(LEAN_INDEX_LINE)
    })
  }

  test('loadMemoryPrompt decides on the indexes the context loaded, for both prompts', () => {
    // Asserted on the SOURCE: the combined prompts sit behind
    // feature('TEAMMEM'), which reads false under `bun test`, so
    // loadMemoryPrompt never reaches them here.
    const src = readFileSync(new URL('./memdir.ts', import.meta.url), 'utf8')
    const start = src.indexOf('export async function loadMemoryPrompt(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))

    expect(body).toContain("await import('src/memory/instructions/claudemd.js')")
    expect(body).toContain('areMemoryIndexesEmpty(await getMemoryFiles())')
    expect(body).toContain('buildLeanCombinedMemoryPrompt(extraGuidelines, indexesEmpty)')
    expect(body).toContain('buildCombinedMemoryPrompt(extraGuidelines, indexesEmpty)')
  })
})
