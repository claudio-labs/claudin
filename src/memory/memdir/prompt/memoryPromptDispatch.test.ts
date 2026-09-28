import { describe, expect, test } from 'bun:test'
import {
  buildMemoryLines,
  buildMemoryStubLines,
} from 'src/memory/memdir/prompt/privateMemoryPrompt.js'
import {
  chooseMemoryPrompt,
  type LoadedInstructionFile,
  loadMemoryPromptWith,
  type MemoryPromptDeps,
} from 'src/memory/memdir/prompt/memoryPromptDispatch.js'

const AUTO_DIR = '/work/app/.claudin/memory/'
const TEAM_DIR = '/work/app/.claudin/memory/team/'

type Recorded = { created: string[]; teamCalls: string[] }

function makeDeps(
  overrides: Partial<MemoryPromptDeps> = {},
): { deps: MemoryPromptDeps; recorded: Recorded } {
  const recorded: Recorded = { created: [], teamCalls: [] }
  const teamBuilder =
    (variant: string) => (extra?: string[], indexesEmpty?: boolean) => {
      const call = `${variant}|${(extra ?? []).join(',')}|${String(indexesEmpty)}`
      recorded.teamCalls.push(call)
      return call
    }
  const deps: MemoryPromptDeps = {
    teamBuild: true,
    isTeamMemoryEnabled: () => true,
    isAutoMemoryEnabled: () => true,
    autoMemDir: () => AUTO_DIR,
    teamMemDir: () => TEAM_DIR,
    ensureDir: async dir => {
      recorded.created.push(dir)
    },
    hasMemories: () => true,
    loadInstructionFiles: async () => [],
    loadTeamPrompts: async () => ({
      buildCombinedMemoryPrompt: teamBuilder('full'),
      buildLeanCombinedMemoryPrompt: teamBuilder('lean'),
    }),
    extraGuidelines: () => undefined,
    ...overrides,
  }
  return { deps, recorded }
}

const INDEX_WITH_ENTRY: LoadedInstructionFile[] = [
  { type: 'AutoMem', content: '- [A](a.md) — hook' },
]

describe('chooseMemoryPrompt', () => {
  test.each([
    [true, true, true, false, { kind: 'team', variant: 'full' }],
    [true, true, true, true, { kind: 'team', variant: 'lean' }],
    [false, true, true, true, { kind: 'private' }],
    [true, false, true, true, { kind: 'private' }],
    [false, false, false, false, { kind: 'none' }],
    [true, false, false, true, { kind: 'none' }],
  ] as const)(
    'flag %p, team %p, auto %p, lean %p gives %p',
    (teamBuild, teamMemoryEnabled, autoMemoryEnabled, lean, expected) => {
      expect(
        chooseMemoryPrompt({ teamBuild, teamMemoryEnabled, autoMemoryEnabled, lean }),
      ).toEqual(expected)
    },
  )
})

describe('loadMemoryPromptWith: the team branch', () => {
  test('creates the team directory and reports empty indexes from what was loaded', async () => {
    const { deps, recorded } = makeDeps({
      loadInstructionFiles: async () => [{ type: 'Project', content: 'rules' }],
    })
    expect(await loadMemoryPromptWith(deps, true)).toBe('lean||true')
    expect(recorded.created).toEqual([TEAM_DIR])
  })

  test('an index with an entry is not empty, and lean picks the builder', async () => {
    const { deps } = makeDeps({ loadInstructionFiles: async () => INDEX_WITH_ENTRY })
    expect(await loadMemoryPromptWith(deps, false)).toBe('full||false')
    expect(await loadMemoryPromptWith(deps, true)).toBe('lean||false')
  })

  test('passes the extra guidelines on', async () => {
    const { deps } = makeDeps({ extraGuidelines: () => ['Keep it short.'] })
    expect(await loadMemoryPromptWith(deps, false)).toBe('full|Keep it short.|true')
  })

  test('a failed load of the indexes counts as not empty instead of throwing', async () => {
    const { deps } = makeDeps({
      loadInstructionFiles: async () => {
        throw new Error('loader exploded')
      },
    })
    expect(await loadMemoryPromptWith(deps, true)).toBe('lean||false')
  })

  test('without the build flag the team switch is not even asked', async () => {
    const { deps, recorded } = makeDeps({
      teamBuild: false,
      isTeamMemoryEnabled: () => {
        throw new Error('asked without the flag')
      },
    })
    const prompt = await loadMemoryPromptWith(deps, true)
    expect(prompt).toBe(buildMemoryLines('auto memory', AUTO_DIR).join('\n'))
    expect(recorded.teamCalls).toEqual([])
  })
})

describe('loadMemoryPromptWith: the private branch', () => {
  test('memories present: the full text; none: the empty-directory text', async () => {
    const withMemories = makeDeps({ teamBuild: false })
    expect(await loadMemoryPromptWith(withMemories.deps, false)).toBe(
      buildMemoryLines('auto memory', AUTO_DIR).join('\n'),
    )
    expect(withMemories.recorded.created).toEqual([AUTO_DIR])

    const empty = makeDeps({ teamBuild: false, hasMemories: () => false })
    expect(await loadMemoryPromptWith(empty.deps, true)).toBe(
      buildMemoryStubLines('auto memory', AUTO_DIR).join('\n'),
    )
  })

  test('auto memory off: null, and nothing is created', async () => {
    const { deps, recorded } = makeDeps({
      teamBuild: false,
      isAutoMemoryEnabled: () => false,
    })
    expect(await loadMemoryPromptWith(deps, false)).toBeNull()
    expect(recorded.created).toEqual([])
  })
})
