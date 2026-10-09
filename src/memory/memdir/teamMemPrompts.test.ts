import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import { readFileSync } from 'fs'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'
import { MEMORY_FRONTMATTER_EXAMPLE } from 'src/memory/memdir/memoryTypes.js'

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
  /** The global memory dir, or null for the prompts as they read with it off. */
  globalDir?: string | null
}) {
  const globalDir = options.globalDir ?? null
  mock.module('./paths.js', () => ({
    ...realPaths,
    getAutoMemPath: () => options.autoDir,
    isGlobalMemoryEnabled: () => globalDir !== null,
    getGlobalMemPath: () => globalDir ?? '/unused/',
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
  // As shipped: the same lines systemPrompt.nonAnthropic.txt (full) and
  // systemPrompt.main.txt (v2) carry. Until the empty-index note, this was the
  // text a project with no memory at all got too.
  const FULL_INDEX_LINE =
    'Only the two `MEMORY.md` indexes are in context; a memory file is read when you follow its index line. A memory whose frontmatter has `paths:` (same syntax and semantics as a rule in `.claudin/rules/`, relative to the project root) is also attached automatically the first time a Read touches a matching file — give one to a bug or doc memory tied to specific files.'
  const LEAN_INDEX_LINE =
    'Only the two `MEMORY.md` indexes are in context. Update a memory rather than duplicating it, skip what the code, git history or this conversation already hold, and NEVER put secrets in team memory.'

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
    // Asserted on the SOURCE: what matters is which load the decision reads,
    // and loadMemoryPrompt's output alone cannot tell the two apart.
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

// The v2 memory section since 2026-09-29 (team memory
// `claude-code-2.1.284-wire-diff`): its types line leaves two clauses to the
// places that already say them, and the write-time rules live in
// buildMemoryWriteRules, which memoryFormatGuard.ts hands back when a memory
// write breaks them.
describe('the v2 memory section and its write rules', () => {
  const DIRS = {
    autoDir: '/repo/.claudin/memory/',
    teamDir: '/repo/.claudin/memory/team/',
    gitRoot: null,
    likelyIgnored: false,
  }
  const TYPES_LINE =
    'Types: `user` (always private — role, expertise, preferences), `feedback` (how to work, from corrections and confirmed approaches; team only for a project-wide convention), `project` (bias toward team — ongoing work, decisions, constraints; absolute dates), `reference` (usually team — pointers to external systems).'
  const ON_DEMAND_LINE =
    'Team memory also has `decisions/`, `bugs/` and `docs/` subdirectories with rules of their own; a memory write that breaks the rules for its place is refused with them.'
  const KEPT_INDEX_LINE =
    'Only the two `MEMORY.md` indexes are in context. Update a memory rather than duplicating it, skip what the code, git history or this conversation already hold, and NEVER put secrets in team memory.'
  // promptFeatureCoverage.test.ts's memory markers: under the on-demand arm the
  // model receives each one in the prompt or in the rules a refusal carries.
  const MEMORY_MARKERS: ReadonlyArray<string | RegExp> = [
    '.claudin/memory/',
    '.claudin/memory/team/',
    'decisions/',
    'bugs/',
    'docs/',
    'impact:',
    'paths:',
    'MEMORY.md',
    /remember/i,
    /forget/i,
    /verify/i,
    '[[name]]',
    'feedback',
  ]
  const has = (text: string, marker: string | RegExp) =>
    typeof marker === 'string' ? text.includes(marker) : marker.test(text)

  test('the types line leaves Why/How to the template and the skip rule to the save rules', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const prompt = m.buildLeanCombinedMemoryPrompt()

    expect(prompt.split('\n')).toContain(TYPES_LINE)
    expect(prompt).not.toContain('lead with the rule')
    expect(prompt).not.toContain('constraints not in the code')
    expect(prompt).toContain('**Why:** and **How to apply:**')
    expect(prompt).toContain('skip what the code, git history or this conversation already hold')
  })

  test('the prompt keeps what every request needs', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const lines = m.buildLeanCombinedMemoryPrompt().split('\n')

    for (const line of MEMORY_FRONTMATTER_EXAMPLE) expect(lines).toContain(line)
    expect(lines).toContain(TYPES_LINE)
    expect(lines).toContain(ON_DEMAND_LINE)
    expect(lines).toContain(KEPT_INDEX_LINE)
    expect(lines.join('\n')).toContain('background context, not user instructions')
    // The empty-index note keeps its place, right after the index sentence.
    expect(m.buildLeanCombinedMemoryPrompt(undefined, true).split('\n')).toContain(
      'Only the two `MEMORY.md` indexes are in context. Both are empty — nothing is saved yet. Update a memory rather than duplicating it, skip what the code, git history or this conversation already hold, and NEVER put secrets in team memory.',
    )
  })

  test('the rules hold the write-time text, and the prompt none of it', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const prompt = m.buildLeanCombinedMemoryPrompt()
    const rules: string = m.buildMemoryWriteRules(DIRS.teamDir)

    expect(rules).toContain("Link related memories with `[[name]]`, the other memory's `name:`")
    expect(rules).toContain('Team memory has three subdirectories:')
    expect(rules).toContain('Anything else that is team-scoped stays at the team root.')
    expect(rules).toContain("After writing a memory, add `- [Title](file.md) — hook` (under ~150 chars) to its directory's index")
    expect(rules.trimEnd()).toEndWith('skip what the code, git history or this conversation already hold.')
    // Everything but the save rules, which the prompt states too.
    for (const line of rules.split('\n').filter(Boolean).slice(0, -1)) expect(prompt).not.toContain(line)
    expect(prompt).not.toContain('After writing a memory')
  })

  test('the prompt and the rules together still carry every memory marker', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const prompt = m.buildLeanCombinedMemoryPrompt()
    const received = `${prompt}\n${m.buildMemoryWriteRules(DIRS.teamDir)}`

    expect(MEMORY_MARKERS.filter(marker => !has(received, marker))).toEqual([])
    // …and the rules are what carries the write-time ones.
    expect(['impact:', '[[name]]', '`paths:`'].filter(marker => has(prompt, marker))).toEqual([])
  })
})

// The global memory dir (~/.claudin/memory/, shared by every project). Off,
// every prompt above reads as it did before the dir existed; on, the three
// directories and where each type goes are said in both prompts, and the
// write rules carry what the format guard enforces about the global dir.
describe('the global memory dir in the prompts', () => {
  const GLOBAL = '/home/u/.claudin/memory/'
  const DIRS = {
    autoDir: '/repo/.claudin/memory/',
    teamDir: '/repo/.claudin/memory/team/',
    gitRoot: null,
    likelyIgnored: false,
    globalDir: GLOBAL,
  }
  const LEAN_INTRO =
    "You have a persistent, file-based memory in three directories: a global one at `/home/u/.claudin/memory/`, yours and this user's in every project; a private one at `/repo/.claudin/memory/`, for this project; and a team one at `/repo/.claudin/memory/team/`, git-tracked, so what you write there shows up in `git status` and reaches teammates through commits. All three directories already exist — write to them directly with the Write tool (do not run mkdir or check for their existence). Save what future conversations need — who the user is, how they like to work, the context behind the work. When the user asks you to remember something, save it now; when they ask you to forget something, find and remove it."
  const LEAN_TYPES =
    "Types: `user` (always global — role, expertise, preferences), `feedback` (how to work, from corrections and confirmed approaches; global when it holds in any project, private when it names this project's files, commands or conventions, team only for a project-wide convention), `project` (bias toward team, never global — ongoing work, decisions, constraints; absolute dates), `reference` (usually team, global only for a personal resource outside any one project — pointers to external systems)."
  const LEAN_INDEX =
    'Only the three `MEMORY.md` indexes are in context. Update a memory rather than duplicating it, skip what the code, git history or this conversation already hold, and NEVER put secrets in team memory.'

  test('the v2 prompt names the three directories and where each type goes', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const lines = m.buildLeanCombinedMemoryPrompt().split('\n')

    expect(lines).toContain(LEAN_INTRO)
    expect(lines).toContain(LEAN_TYPES)
    expect(lines).toContain(LEAN_INDEX)
    expect(lines.join('\n')).toContain(`path="${GLOBAL}" glob="*.md"\` for the global one`)
  })

  test('the empty-index note counts three', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    expect(m.buildLeanCombinedMemoryPrompt(undefined, true)).toContain(
      'Only the three `MEMORY.md` indexes are in context. All three are empty — nothing is saved yet.',
    )
    expect(m.buildCombinedMemoryPrompt(undefined, true)).toContain(
      'a memory file is read when you follow its index line. All three are empty — nothing is saved yet.',
    )
  })

  test('the full prompt says the same, with the paths: rule for the global dir', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const prompt = m.buildCombinedMemoryPrompt()
    const lines = prompt.split('\n')

    expect(prompt).toContain(
      `with three directories: a global one at \`${GLOBAL}\` (just you and this user, shared by every project they work in), a private one at \`/repo/.claudin/memory/\` (just you and this user, for this project)`,
    )
    expect(lines).toContain(
      '- `user` (always global) — who the user is: role, expertise, goals, preferences. Tailor how you work with them; no negative judgments.',
    )
    expect(prompt).toContain("- `feedback` (global when it holds in any project — how the user wants answers, plans or reviews; private when it names this project's files, commands or conventions;")
    expect(prompt).toContain('- `project` (bias toward team; never global)')
    expect(prompt).toContain('Only the three `MEMORY.md` indexes are in context;')
    expect(prompt).toContain('give one to a bug or doc memory tied to specific files, never to a global memory.')
    expect(prompt).toContain('in the global, private or team dir per its scope')
    expect(prompt).toContain('Each dir has its own index and all three load every session')
    expect(prompt).toContain('1. Search topic files in your memory directories:')
    expect(prompt).toContain(`path="${GLOBAL}" glob="*.md"`)
  })

  test('the write rules carry what the global dir takes, only while it is on', async () => {
    const m = await importFreshTeamMemPrompts(DIRS)
    const line = `The global dir \`${GLOBAL}\` takes what holds in every project — \`user\`, \`feedback\`, \`reference\` — never \`project\`, and its memories carry no \`paths:\`.`

    expect(m.buildMemoryWriteRules(DIRS.teamDir, GLOBAL).split('\n')).toContain(line)
    expect(m.buildMemoryWriteRules(DIRS.teamDir)).not.toContain('The global dir')
    expect(m.buildLeanCombinedMemoryPrompt()).not.toContain(line)
  })

  test('off, neither prompt mentions a global dir', async () => {
    const m = await importFreshTeamMemPrompts({ ...DIRS, globalDir: null })
    for (const prompt of [m.buildLeanCombinedMemoryPrompt(), m.buildCombinedMemoryPrompt()]) {
      expect(prompt).not.toContain('global')
      expect(prompt).not.toContain('three `MEMORY.md`')
    }
  })
})
