import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { getAutoMemPath } from 'src/memdir/paths.js'
import type { LocalJSXCommandOnDone } from 'src/types/command.js'
import { parseMemorySubcommand, runMemoryTidy } from './tidy.js'

// Mock the team-root boundary so the team-on path is reachable under bun test
// (the preload stubs bun:bundle's feature() → false, so resolveTidyTeamRoot
// would otherwise always return null). Canonical teardown: snapshot the real
// exports BEFORE mocking, re-mock in afterAll.
const realTidyTeam = { ...(await import('./tidyTeam.js')) }
let tidyTeamRoot: string | null = null
mock.module('./tidyTeam.js', () => ({
  ...realTidyTeam,
  resolveTidyTeamRoot: () => tidyTeamRoot,
}))
mock.module('src/commands/memory/tidyTeam.js', () => ({
  ...realTidyTeam,
  resolveTidyTeamRoot: () => tidyTeamRoot,
}))

afterAll(() => {
  mock.module('./tidyTeam.js', () => realTidyTeam)
  mock.module('src/commands/memory/tidyTeam.js', () => realTidyTeam)
})

const DISABLE_ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY'
const savedDisableEnv = process.env[DISABLE_ENV]

afterEach(() => {
  tidyTeamRoot = null
  // Snapshot+restore, not delete — a pre-existing user value must survive.
  if (savedDisableEnv === undefined) {
    delete process.env[DISABLE_ENV]
  } else {
    process.env[DISABLE_ENV] = savedDisableEnv
  }
})

type OnDoneCall = {
  result?: string
  options?: Parameters<LocalJSXCommandOnDone>[1]
}

function recordingOnDone(): {
  onDone: LocalJSXCommandOnDone
  calls: OnDoneCall[]
} {
  const calls: OnDoneCall[] = []
  const onDone: LocalJSXCommandOnDone = (result, options) => {
    calls.push({ result, options })
  }
  return { onDone, calls }
}

describe('parseMemorySubcommand', () => {
  test('empty or whitespace args → null (dialog flow)', () => {
    expect(parseMemorySubcommand('')).toBeNull()
    expect(parseMemorySubcommand('   ')).toBeNull()
  })

  test('unknown args → null (dialog flow)', () => {
    expect(parseMemorySubcommand('edit')).toBeNull()
    expect(parseMemorySubcommand('tidying')).toBeNull()
    expect(parseMemorySubcommand('tidy now')).toBeNull()
  })

  test('tidy keyword → tidy (trimmed)', () => {
    expect(parseMemorySubcommand('tidy')).toBe('tidy')
    expect(parseMemorySubcommand('  tidy  ')).toBe('tidy')
  })
})

describe('runMemoryTidy', () => {
  test('hands the tidy prompt to the model via shouldQuery + metaMessages', () => {
    // Pin enabled explicitly — isAutoMemoryEnabled() otherwise reads the
    // machine's real settings.json, making this test environment-dependent.
    process.env[DISABLE_ENV] = '0'
    const { onDone, calls } = recordingOnDone()
    const returned = runMemoryTidy(onDone)

    expect(returned).toBeNull()
    expect(calls).toHaveLength(1)
    const [{ result, options }] = calls
    expect(result).toContain('memory tidy')
    expect(options?.display).toBe('system')
    expect(options?.shouldQuery).toBe(true)
    expect(options?.metaMessages).toHaveLength(1)
    const prompt = options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('Memory Tidy')
    expect(prompt).toContain(getAutoMemPath().replace(/[/\\]+$/, ''))
    // Team off in this test → no team section
    expect(prompt).not.toContain('## Team memory')
  })

  test('team root resolved → team section included in the prompt', () => {
    process.env[DISABLE_ENV] = '0'
    tidyTeamRoot = '/repo/.claudin/memory/team/'
    const { onDone, calls } = recordingOnDone()
    runMemoryTidy(onDone)

    const prompt = calls[0]?.options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('## Team memory')
    expect(prompt).toContain('/repo/.claudin/memory/team/MEMORY.md')
    expect(prompt).not.toContain('//MEMORY.md')
  })

  test('auto memory disabled → system warning, no query', () => {
    process.env[DISABLE_ENV] = '1'
    const { onDone, calls } = recordingOnDone()
    const returned = runMemoryTidy(onDone)

    expect(returned).toBeNull()
    expect(calls).toHaveLength(1)
    const [{ result, options }] = calls
    expect(result).toContain('auto memory is disabled')
    expect(options?.display).toBe('system')
    expect(options?.shouldQuery).toBeUndefined()
    expect(options?.metaMessages).toBeUndefined()
  })
})
