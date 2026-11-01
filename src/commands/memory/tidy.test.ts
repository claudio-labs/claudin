import { afterEach, describe, expect, test } from 'bun:test'
import { getPrivateMemPath } from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import {
  explainScopeOff,
  memoryScopeOffMessage,
  parseMemorySubcommand,
  runMemorySort,
  runMemoryTidy,
  SUBCOMMANDS,
} from 'src/commands/memory/tidy.js'
import memoryCommand from 'src/commands/memory/index.js'
import { MEMORY_SCOPES } from 'src/memory/memdir/memoryScopes.js'

// Team memory is on whenever auto memory is, so every run covers the team dir.
const teamRoot = (): string => getTeamMemPath().replace(/[/\\]+$/, '')

const DISABLE_ENV = 'CLAUDIN_DISABLE_AUTO_MEMORY'
const savedDisableEnv = process.env[DISABLE_ENV]
const GLOBAL_ENV = 'CLAUDIN_GLOBAL_MEMORY'
const savedGlobalEnv = process.env[GLOBAL_ENV]

afterEach(() => {
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

/** An audit that finds nothing, so the prompt under test does not depend on this checkout's memory. */
const cleanAudit = async () => ({ files: 0, findings: [] })

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

  test('every memory scope is a subcommand, after the two actions', () => {
    expect(SUBCOMMANDS).toEqual(['tidy', 'sort', ...MEMORY_SCOPES])
    for (const scope of MEMORY_SCOPES) {
      expect(parseMemorySubcommand(scope)).toBe(scope)
    }
  })

  test("the command's hint and description list exactly these subcommands", () => {
    expect(memoryCommand.argumentHint).toBe(`[${SUBCOMMANDS.join('|')}]`)
    expect(memoryCommand.description).toContain(`/memory ${MEMORY_SCOPES.join('|')} opens a memory directory`)
    expect(memoryCommand.description).toContain('promotes what is about you to the global memory')
  })
})

describe('/memory <scope> with the directory off', () => {
  test('memory off is the reason for every scope', () => {
    for (const scope of MEMORY_SCOPES) {
      expect(explainScopeOff(scope, { reason: 'auto-memory-off' })).toContain('auto memory is disabled')
    }
  })

  test('CLAUDIN_GLOBAL_MEMORY=0', () => {
    expect(explainScopeOff('global', { reason: 'env' })).toBe(
      'Global memory is off: CLAUDIN_GLOBAL_MEMORY=0 is set. Unset it to share memories about you across projects.',
    )
  })

  test('a Cowork override', () => {
    expect(explainScopeOff('global', { reason: 'cowork-override' })).toContain('CLAUDE_COWORK_MEMORY_PATH_OVERRIDE')
  })

  test('the global and private dirs nesting', () => {
    const inside = explainScopeOff('global', {
      reason: 'nested',
      globalDir: '/home/u/.claudin/memory/',
      privateDir: '/home/u/.claudin/memory/repo/',
    })
    expect(inside).toContain(
      "the global dir /home/u/.claudin/memory and this project's private dir /home/u/.claudin/memory/repo are one inside the other",
    )
    expect(inside).toContain('autoMemoryGlobalDirectory')
  })

  // The reason is paths.ts globalMemoryOffReason's, so its order is the
  // order isGlobalMemoryEnabled decides in — nothing here re-derives it.
  test('the live message reads the reason paths.ts gives', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '0'
    expect(memoryScopeOffMessage('global')).toContain('CLAUDIN_GLOBAL_MEMORY=0 is set')
    process.env[DISABLE_ENV] = '1'
    expect(memoryScopeOffMessage('global')).toContain('auto memory is disabled')
  })
})

describe('runMemoryTidy', () => {
  test('hands the tidy prompt to the model via shouldQuery + metaMessages', async () => {
    // Pin enabled explicitly — isAutoMemoryEnabled() otherwise reads the
    // machine's real settings.json, making this test environment-dependent.
    process.env[DISABLE_ENV] = '0'
    const { onDone, calls } = recordingOnDone()
    const returned = await runMemoryTidy(onDone, cleanAudit)

    expect(returned).toBeNull()
    expect(calls).toHaveLength(1)
    const [{ result, options }] = calls
    expect(result).toContain('memory tidy')
    expect(options?.display).toBe('system')
    expect(options?.shouldQuery).toBe(true)
    expect(options?.metaMessages).toHaveLength(1)
    const prompt = options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('Memory Tidy')
    expect(prompt).toContain(getPrivateMemPath().replace(/[/\\]+$/, ''))
  })

  test('the team section is included in the prompt', async () => {
    process.env[DISABLE_ENV] = '0'
    const { onDone, calls } = recordingOnDone()
    await runMemoryTidy(onDone, cleanAudit)

    const prompt = calls[0]?.options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('## Team memory')
    expect(prompt).toContain(`${teamRoot()}/MEMORY.md`)
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).toContain("`/memory sort`'s job")
  })

  test('global dir on → global section included; off → not', async () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '1'
    const on = recordingOnDone()
    await runMemoryTidy(on.onDone, cleanAudit)
    expect(on.calls[0]?.options?.metaMessages?.[0] ?? '').toContain('## Global memory')

    process.env[GLOBAL_ENV] = '0'
    const off = recordingOnDone()
    await runMemoryTidy(off.onDone, cleanAudit)
    expect(off.calls[0]?.options?.metaMessages?.[0] ?? '').not.toContain('## Global memory')
  })

  test('the audit findings ride in the prompt; an audit that throws leaves them out, not the tidy', async () => {
    process.env[DISABLE_ENV] = '0'
    const found = recordingOnDone()
    await runMemoryTidy(found.onDone, async () => ({
      files: 2,
      findings: [{ kind: 'expired', scope: 'private', path: '/r/.claudin/memory/oncall.md', expires: '2026-09-30' }],
    }))
    const prompt = found.calls[0]?.options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('- Past its `expires:` date (2026-09-30): `/r/.claudin/memory/oncall.md`')
    expect(prompt).toContain('- **Expired, for review**')

    const failed = recordingOnDone()
    await runMemoryTidy(failed.onDone, async () => {
      throw new Error('unreadable')
    })
    expect(failed.calls[0]?.options?.shouldQuery).toBe(true)
    expect(failed.calls[0]?.options?.metaMessages?.[0] ?? '').not.toContain('Found before you started')
  })

  test('CLAUDIN_MEMORY_HYGIENE=0 keeps the hygiene findings out of the prompt, and the rest in', async () => {
    process.env[DISABLE_ENV] = '0'
    const saved = process.env.CLAUDIN_MEMORY_HYGIENE
    const audit = async () => ({
      files: 2,
      findings: [
        { kind: 'expired' as const, scope: 'private' as const, path: '/r/.claudin/memory/oncall.md', expires: '2026-09-30' },
        { kind: 'oversize' as const, scope: 'private' as const, path: '/r/.claudin/memory/profile.md', bytes: 13_000 },
      ],
    })
    try {
      process.env.CLAUDIN_MEMORY_HYGIENE = '0'
      const off = recordingOnDone()
      await runMemoryTidy(off.onDone, audit)
      const prompt = off.calls[0]?.options?.metaMessages?.[0] ?? ''
      expect(prompt).toContain('/r/.claudin/memory/oncall.md')
      expect(prompt).not.toContain('/r/.claudin/memory/profile.md')
      delete process.env.CLAUDIN_MEMORY_HYGIENE
      const on = recordingOnDone()
      await runMemoryTidy(on.onDone, audit)
      expect(on.calls[0]?.options?.metaMessages?.[0] ?? '').toContain('/r/.claudin/memory/profile.md')
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
      else process.env.CLAUDIN_MEMORY_HYGIENE = saved
    }
  })

  test('auto memory disabled → system warning, no query', async () => {
    process.env[DISABLE_ENV] = '1'
    const { onDone, calls } = recordingOnDone()
    const returned = await runMemoryTidy(onDone, cleanAudit)

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
  test('hands the sort prompt to the model', () => {
    process.env[DISABLE_ENV] = '0'
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
    expect(prompt).toContain(`${teamRoot()}/MEMORY.md`)
  })

  test('global dir off → the team filing alone', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '0'
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toBe('Running memory sort — filing team memories into decisions/, bugs/ and docs/…')
    expect(options?.shouldQuery).toBe(true)
    expect(options?.metaMessages?.[0] ?? '').not.toContain('# Part 2 — promote')
  })

  test('global dir on → both parts', () => {
    process.env[DISABLE_ENV] = '0'
    process.env[GLOBAL_ENV] = '1'
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toContain('filing team memories into decisions/, bugs/ and docs/, and promoting what is about you')
    const prompt = options?.metaMessages?.[0] ?? ''
    expect(prompt).toContain('# Part 2 — promote')
    expect(prompt).toContain(getPrivateMemPath().replace(/[/\\]+$/, ''))
  })

  test('auto memory disabled → system warning, no query', () => {
    process.env[DISABLE_ENV] = '1'
    const { onDone, calls } = recordingOnDone()
    runMemorySort(onDone)

    const [{ result, options }] = calls
    expect(result).toContain('auto memory is disabled')
    expect(options?.shouldQuery).toBeUndefined()
  })
})
