import { describe, expect, test } from 'bun:test'
import {
  buildDreamDigest,
  collectDreamDigest,
  DEFAULT_DIGEST_CAPS,
  extractPlanSections,
  isImpactfulCommitSubject,
  summarizePlanBlastRadius,
} from 'src/memory/autoDream/dreamDigest.js'

const PLAN = `# Memory v2

## Context

The HTTP sync only worked with first-party OAuth; the team dir is git-tracked, so git IS the sync.

## Agreed Decisions

- Delete the HTTP sync; keep the secret guard.
- Directory = category; \`type\` unchanged.

## Open Questions

(empty)

## Tasks

- [ ] Delete the sync
  - files: src/memory/teamSync/index.ts, src/memory/teamSync/watcher.ts, src/platform/setup.ts
- [ ] Add the loader
  - files: src/memory/memdir/pathScopedMemories.ts (novo), src/memory/memdir/pathScopedMemories.test.ts (new), src/agent/attachments/memory.ts
- [ ] Move the guard
  - files: src/memory/teamSync/secretScanner.ts → src/memory/memdir/secretScanner.ts, docs/tech/memory/project-local-team-memory.md
`

describe('summarizePlanBlastRadius', () => {
  test('counts distinct files, their slices and the new-file markers from Tasks only', () => {
    const radius = summarizePlanBlastRadius(PLAN)
    expect(radius.files).toBe(8)
    expect(radius.slices).toEqual(['agent', 'docs', 'memory', 'platform'])
    expect(radius.newFiles).toBe(2)
  })

  test('a plan without a Tasks section has an empty radius', () => {
    // The line has the `- files:` bullet shape on purpose: without it the
    // regex would reject it before the Tasks gate ever ran, and the test
    // would pass with that gate deleted.
    expect(summarizePlanBlastRadius('# x\n\n## Context\n\n- files: a.ts\n')).toEqual({
      files: 0,
      slices: [],
      newFiles: 0,
    })
  })
})

describe('extractPlanSections', () => {
  test('returns the Context and Agreed Decisions bodies, trimmed', () => {
    const { context, decisions } = extractPlanSections(PLAN)
    expect(context).toBe(
      'The HTTP sync only worked with first-party OAuth; the team dir is git-tracked, so git IS the sync.',
    )
    expect(decisions).toStartWith('- Delete the HTTP sync')
    expect(decisions).not.toContain('Open Questions')
  })

  test('missing sections are empty strings', () => {
    expect(extractPlanSections('# nothing here\n')).toEqual({
      context: '',
      decisions: '',
    })
  })
})

describe('isImpactfulCommitSubject', () => {
  test('keeps feat, refactor and breaking subjects', () => {
    expect(isImpactfulCommitSubject('feat(memory): add /memory sort')).toBe(true)
    expect(isImpactfulCommitSubject('refactor(reorg): retire the buckets')).toBe(true)
    expect(isImpactfulCommitSubject('fix(build)!: drop node 20')).toBe(true)
    expect(isImpactfulCommitSubject('feat!: breaking')).toBe(true)
  })

  test('drops fix, chore, docs and unconventional subjects', () => {
    expect(isImpactfulCommitSubject('fix(test): flaky snapshot')).toBe(false)
    expect(isImpactfulCommitSubject('chore(deps): bump zod')).toBe(false)
    expect(isImpactfulCommitSubject('docs(memory): fix cites')).toBe(false)
    expect(isImpactfulCommitSubject('Initial commit')).toBe(false)
  })
})

describe('buildDreamDigest', () => {
  const since = Date.UTC(2026, 8, 20)
  const inputs = {
    sinceMs: since,
    plans: [
      { path: '/repo/.claudin/plans/memory-v2.md', mtimeMs: since + 1, content: PLAN },
      { path: '/repo/.claudin/plans/old.md', mtimeMs: since - 1, content: PLAN },
    ],
    sessions: [
      {
        sessionId: 'abcdef12-0000-0000-0000-000000000000',
        mtimeMs: since + 2,
        firstPrompt: 'vamos apagar o team sync e criar decisions/bugs/docs',
        customTitle: 'memory v2',
        summary: 'planned the memory rework',
      },
      {
        sessionId: 'stale000-0000-0000-0000-000000000000',
        mtimeMs: since - 5,
        firstPrompt: 'older than the period',
      },
    ],
    commitSubjects: [
      'feat(memory): path-scoped memories',
      'chore(deps): bump',
      'refactor(memory): delete the http sync',
    ],
    cwd: '/repo',
  }

  test('renders only the period, with the radius, the sections and the filtered commits', () => {
    const digest = buildDreamDigest(inputs)
    expect(digest).toContain('### Plans modified (1)')
    expect(digest).toContain(
      '- `/repo/.claudin/plans/memory-v2.md` — 8 files across 4 slices (agent, docs, memory, platform), 2 new',
    )
    expect(digest).toContain('Agreed Decisions:')
    expect(digest).toContain('- Delete the HTTP sync; keep the secret guard.')
    expect(digest).not.toContain('old.md')

    expect(digest).toContain('### Session prompts (1)')
    expect(digest).toContain('- abcdef12 · memory v2 — "vamos apagar o team sync')
    expect(digest).toContain('summary: planned the memory rework')
    expect(digest).not.toContain('older than the period')

    expect(digest).toContain('### Commits — feat / refactor / breaking (2)')
    expect(digest).toContain('- feat(memory): path-scoped memories')
    expect(digest).not.toContain('chore(deps)')
  })

  test('an empty period says so instead of rendering empty sections', () => {
    const digest = buildDreamDigest({
      sinceMs: since,
      plans: [],
      sessions: [],
      commitSubjects: ['fix: nothing impactful'],
      cwd: '/repo',
    })
    expect(digest).toContain('Nothing was modified in this period')
    expect(digest).not.toContain('###')
  })

  test('caps the plan section and lists the overflow by path', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `/repo/.claudin/plans/plan-${i}.md`,
      mtimeMs: since + 100 - i,
      content: PLAN,
    }))
    const digest = buildDreamDigest(
      { sinceMs: since, plans: many, sessions: [], commitSubjects: [], cwd: '/repo' },
      { ...DEFAULT_DIGEST_CAPS, plansChars: 1_200 },
    )
    expect(digest).toContain('### Plans modified (12)')
    expect(digest).toContain('Also modified, not expanded here')
    // Newest first, so plan-0 is expanded and the tail is the overflow list.
    expect(digest.indexOf('plan-0.md')).toBeLessThan(digest.indexOf('plan-11.md'))
    expect(digest.length).toBeLessThan(3_000)
  })

  test('expired memories get their own section with what to do, even in an empty period', () => {
    const digest = buildDreamDigest({
      sinceMs: since,
      plans: [],
      sessions: [],
      commitSubjects: [],
      expired: [
        { path: '/repo/.claudin/memory/team/freeze.md', expires: '2026-09-30' },
        { path: '/home/u/.claudin/memory/rotation.md', expires: '2026-10-01' },
      ],
      cwd: '/repo',
    })
    expect(digest).toContain('Nothing was modified in this period')
    expect(digest).toContain('## Memories past their `expires:` date (2)')
    expect(digest).toContain('An expired date alone is never a reason to delete.')
    expect(digest).toContain('- `/repo/.claudin/memory/team/freeze.md` — expired 2026-09-30')
    expect(buildDreamDigest({ sinceMs: since, plans: [], sessions: [], commitSubjects: [], cwd: '/repo' })).not.toContain('expires:')
  })

  test('with memory hygiene on, an expired snapshot is folded and deleted; the findings come with what to do', () => {
    const digest = buildDreamDigest({
      sinceMs: since,
      plans: [],
      sessions: [],
      commitSubjects: [],
      expired: [{ path: '/repo/.claudin/memory/team/bench-2026-08-01.md', expires: '2026-09-01' }],
      hygiene: [
        { kind: 'near-duplicate', scope: 'private', path: '/repo/.claudin/memory/copy.md', other: { scope: 'global', path: '/home/u/.claudin/memory/lang.md' }, score: 0.64 },
        { kind: 'misplaced-type', scope: 'private', path: '/repo/.claudin/memory/user-role.md', type: 'user' },
        { kind: 'open-contradiction', scope: 'team', path: '/repo/.claudin/memory/team/t-b.md', targets: ['t-a'] },
        { kind: 'index-over-cap', scope: 'team', path: '/repo/.claudin/memory/team/MEMORY.md', bytes: 26_000, lines: 180, shortened: 12 },
        { kind: 'oversize', scope: 'private', path: '/repo/.claudin/memory/profile.md', bytes: 13_000 },
      ],
      cwd: '/repo',
    })
    expect(digest).toContain('fold its conclusion into the decision or memory it supports, then delete it')
    expect(digest).not.toContain('An expired date alone is never a reason to delete.')
    expect(digest).toContain('## Memory hygiene (5)')
    expect(digest).toContain('never from which file is newer')
    expect(digest).toContain('- near-duplicate: `.claudin/memory/copy.md` (private) reads like `/home/u/.claudin/memory/lang.md` (global, 0.64)')
    expect(digest).toContain('- user memory outside the global dir: `.claudin/memory/user-role.md` (private)')
    expect(digest).toContain('- contradiction: `.claudin/memory/team/t-b.md` (team) contradicts `t-a`')
    expect(digest).toContain('- index over its cap: `.claudin/memory/team/MEMORY.md`, 180 lines and 26000 bytes, 12 entries load without their hook')
    expect(digest).toContain('- oversized: `.claudin/memory/profile.md` (private), 13 KB read whole on every recall')
  })

  test('with memory hygiene on and nothing found, there is no hygiene section', () => {
    const digest = buildDreamDigest({ sinceMs: since, plans: [], sessions: [], commitSubjects: [], hygiene: [], cwd: '/repo' })
    expect(digest).not.toContain('## Memory hygiene')
  })

  test('each session names the memories it wrote; what changed with no session is listed apart', () => {
    const writes = Array.from({ length: 7 }, (_, i) => `/repo/.claudin/memory/m${i}.md`)
    const digest = buildDreamDigest({
      sinceMs: since,
      plans: [],
      sessions: [{ sessionId: 'abcdef12-0000-0000-0000-000000000000', mtimeMs: since + 1, firstPrompt: 'remember pnpm', memoryWrites: writes }],
      commitSubjects: [],
      changedMemories: ['/repo/.claudin/memory/m0.md', '/repo/.claudin/memory/team/bugs/x.md', '/home/u/.claudin/memory/g.md'],
      cwd: '/repo',
    })
    expect(digest).toContain(
      '- abcdef12 · "remember pnpm"\n  memories written: .claudin/memory/m0.md, .claudin/memory/m1.md, .claudin/memory/m2.md, .claudin/memory/m3.md, .claudin/memory/m4.md and 2 more',
    )
    expect(digest).toContain('### Memories also changed in this period (2) — by a background pass or by hand')
    expect(digest).toContain('- .claudin/memory/team/bugs/x.md')
    expect(digest).toContain('- /home/u/.claudin/memory/g.md')
    expect(digest).not.toContain('Nothing was modified')
  })

  test('only an unattributed change still counts as something modified', () => {
    const digest = buildDreamDigest({ sinceMs: since, plans: [], sessions: [], commitSubjects: [], changedMemories: ['/r/x.md'], cwd: '/repo' })
    expect(digest).not.toContain('Nothing was modified')
    expect(digest).toContain('- /r/x.md')
  })

  test('clips a long prompt to the prompt cap', () => {
    const digest = buildDreamDigest({
      sinceMs: since,
      plans: [],
      sessions: [
        {
          sessionId: 'long0000-0000-0000-0000-000000000000',
          mtimeMs: since + 1,
          firstPrompt: 'x'.repeat(1_000),
        },
      ],
      commitSubjects: [],
      cwd: '/repo',
    })
    const line = digest.split('\n').find(l => l.startsWith('- long0000'))!
    expect(line.length).toBeLessThan(DEFAULT_DIGEST_CAPS.promptChars + 40)
    expect(line).toEndWith('…"')
  })
})

describe('collectDreamDigest', () => {
  test('a source that throws is left out, the others still render', async () => {
    const digest = await collectDreamDigest(1_000, ['s1'], {
      listPlans: async () => {
        throw new Error('plans dir unreadable')
      },
      listSessions: async ids => [
        {
          sessionId: ids[0]!,
          mtimeMs: 2_000,
          firstPrompt: 'decide the thing',
        },
      ],
      commitSubjectsSince: async () => ['feat(x): the thing'],
      listMemoryHeaders: async () => {
        throw new Error('memory dirs unreadable')
      },
    })
    expect(digest).not.toContain('### Plans')
    expect(digest).toContain('### Session prompts (1)')
    expect(digest).toContain('- feat(x): the thing')
    expect(digest).not.toContain('expires:')
  })

  // One scan feeds both memory lists: the expired ones and what changed in
  // the period, each derived from the same headers.
  test('one scan of the memory headers yields the expired and the changed memories', async () => {
    const header = (filePath: string, mtimeMs: number, expires: string | null) => ({
      filename: filePath.split('/').pop()!,
      filePath,
      mtimeMs,
      description: null,
      type: 'project' as const,
      expires,
    })
    let scans = 0
    const digest = await collectDreamDigest(1_000, [], {
      listPlans: async () => [],
      listSessions: async () => [],
      commitSubjectsSince: async () => [],
      listMemoryHeaders: async () => {
        scans++
        return [
          header('/r/.claudin/memory/oncall.md', 500, '2026-09-30'),
          header('/r/.claudin/memory/later.md', 500, '2999-01-01'),
          header('/r/.claudin/memory/team/bugs/new.md', 2_000, null),
        ]
      },
    })
    expect(scans).toBe(1)
    expect(digest).toContain('- `/r/.claudin/memory/oncall.md` — expired 2026-09-30')
    expect(digest).not.toContain('later.md')
    expect(digest).toContain('### Memories also changed in this period (1)')
    expect(digest).toContain('new.md')
    expect(digest).not.toContain('- /r/.claudin/memory/oncall.md\n')
  })

  test('the hygiene findings are asked for unless CLAUDIN_MEMORY_HYGIENE=0, and a failing scan leaves the section out', async () => {
    const saved = process.env.CLAUDIN_MEMORY_HYGIENE
    const deps = (find: () => Promise<never[] | Array<{ kind: 'oversize'; scope: 'private'; path: string; bytes: number }>>) => ({
      listPlans: async () => [],
      listSessions: async () => [],
      commitSubjectsSince: async () => [],
      listMemoryHeaders: async () => [],
      listHygieneFindings: find,
    })
    const big = async () => [{ kind: 'oversize' as const, scope: 'private' as const, path: '/r/.claudin/memory/big.md', bytes: 9_000 }]
    try {
      delete process.env.CLAUDIN_MEMORY_HYGIENE
      expect(await collectDreamDigest(1_000, [], deps(big))).toContain('## Memory hygiene (1)')
      expect(
        await collectDreamDigest(
          1_000,
          [],
          deps(async () => {
            throw new Error('EACCES')
          }),
        ),
      ).not.toContain('## Memory hygiene')
      process.env.CLAUDIN_MEMORY_HYGIENE = '0'
      expect(await collectDreamDigest(1_000, [], deps(big))).not.toContain('## Memory hygiene')
    } finally {
      if (saved === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
      else process.env.CLAUDIN_MEMORY_HYGIENE = saved
    }
  })
})
