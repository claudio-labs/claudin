import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import {
  parseMemorySubcommand,
  runMemorySort,
  runMemoryTidy,
} from 'src/commands/memory/tidy.js'

// Mock the team-root boundary so the team-on path is reachable under bun test
// (the preload stubs bun:bundle's feature() → false, so resolveTidyTeamRoot
// would otherwise always return null). Canonical teardown: snapshot the real
// exports BEFORE mocking, re-mock in afterAll.
const realTidyTeam = { ...(await import('src/commands/memory/tidyTeam.js')) }
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

const DISABLE_ENV = 'CLAUDIN_DISABLE_AUTO_MEMORY'
const savedDisableEnv = process.env[DISABLE_ENV]
const GLOBAL_ENV = 'CLAUDIN_GLOBAL_MEMORY'
const savedGlobalEnv = process.env[GLOBAL_ENV]

afterEach(() => {
  tidyTeamRoot = null
  // Snapshot+restore, not delete — a pre-existing user value must survive.
  if (savedDisableEnv === undefined) {
    delete process.env[DISABLE_ENV]
  } else {
    process.env[DISABLE_ENV] = savedDisableEnv
  }
  if (savedGlobalEnv === undefined) {
    delete process.env[GLOBAL_ENV]
  } else {
    process.env[GLOBAL_ENV] = savedGlobalEnv
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

  test('sort keyword → sort (trimmed)', () => {
    expect(parseMemorySubcommand('sort')).toBe('sort')
    expect(parseMemorySubcommand('  sort  ')).toBe('sort')
    expect(parseMemorySubcommand('sorted')).toBeNull()
  })

  test('private and team open their browser directly', () => {
    expect(parseMemorySubcommand('private')).toBe('private')
    expect(parseMemorySubcommand('  team  ')).toBe('team')
    expect(parseMemorySubcommand('global')).toBe('global')
  })

  test('a near miss still falls through to the dialog', () => {
    expect(parseMemorySubcommand('teams')).toBeNull()
    expect(parseMemorySubcommand('private memory')).toBeNull()
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
    expect(prompt).toContain("`/memory sort`'s job")
  })

  test('global dir on → global section included; off → not', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '1'
    const on = recordingOnDone()
    runMemoryTidy(on.onDone)
    expect(on.calls[0]?.options?.metaMessages?.[0] ?? '').toContain('## Global memory')

    process.env[GLOBAL_ENV] = '0'
    const off = recordingOnDone()
    runMemoryTidy(off.onDone)
    expect(off.calls[0]?.options?.metaMessages?.[0] ?? '').not.toContain('## Global memory')
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

describe('runMemorySort', () => {
  test('team root resolved → hands the sort prompt to the model', () => {
    process.env[DISABLE_ENV] = '0'
    tidyTeamRoot = '/repo/.claudin/memory/team/'
    const { onDone, calls } = recordingOnDone()
    const returned = runMemorySort(onDone)

    expect(returned).toBeNull()
    expect(calls).toHaveLength(1)
    const [{ result, options }] = calls
    expect(result).toContain('memory sort')
    expect(options?.display).toBe('system')
    expect(options?.shouldQuery).toBe(true)
    const prompt = options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('Memory Sort')
    expect(prompt).toContain('/repo/.claudin/memory/team/MEMORY.md')
  })

  test('no team root → system notice, no query', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '0'
    tidyTeamRoot = null
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toContain('team memory is not active')
    expect(options?.shouldQuery).toBeUndefined()
  })

  test('no team root but the global dir on → the promotion alone', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '1'
    tidyTeamRoot = null
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toBe('Running memory sort — promoting what is about you to the global memory…')
    expect(options?.shouldQuery).toBe(true)
    const prompt = options?.metaMessages?.[0] ?? ''
    expect(prompt).toStartWith('# Memory Sort: promote what is about the user to the global memory')
    expect(prompt).toContain(getAutoMemPath().replace(/[/\\]+$/, ''))
  })

  test('team root and the global dir → both parts', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '1'
    tidyTeamRoot = '/repo/.claudin/memory/team/'
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toContain('filing team memories into decisions/, bugs/ and docs/, and promoting what is about you')
    expect(options?.metaMessages?.[0] ?? '').toContain('# Part 2 — promote')
  })

  test('auto memory disabled → system warning, no query', () => {
    process.env[DISABLE_ENV] = '1'
    tidyTeamRoot = '/repo/.claudin/memory/team/'
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toContain('auto memory is disabled')
    expect(options?.shouldQuery).toBeUndefined()
  })
})
