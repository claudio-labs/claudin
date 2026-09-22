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
      { sinceMs: since, plans: many, sessions: [], commitSubjects: [] },
      { ...DEFAULT_DIGEST_CAPS, plansChars: 1_200 },
    )
    expect(digest).toContain('### Plans modified (12)')
    expect(digest).toContain('Also modified, not expanded here')
    // Newest first, so plan-0 is expanded and the tail is the overflow list.
    expect(digest.indexOf('plan-0.md')).toBeLessThan(digest.indexOf('plan-11.md'))
    expect(digest.length).toBeLessThan(3_000)
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
    })
    expect(digest).not.toContain('### Plans')
    expect(digest).toContain('### Session prompts (1)')
    expect(digest).toContain('- feat(x): the thing')
  })
})
