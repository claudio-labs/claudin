import { afterEach, describe, expect, test } from 'bun:test'
import type { AuditedFile } from 'src/memory/memdir/memoryAudit.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'
import {
  findHygieneFindings,
  isMemoryHygieneEnabled,
  memoryTokens,
  NEAR_DUPLICATE_MIN,
  nearDuplicateScore,
  OVERSIZE_BYTES,
  similarMemories,
} from 'src/memory/memdir/memoryHygiene.js'

const GLOBAL = '/home/u/.claudin/memory/'
const PRIVATE = '/repo/.claudin/memory/'
const TEAM = '/repo/.claudin/memory/team/'
const dirs = testMemoryDirs({ global: GLOBAL, private: PRIVATE, team: TEAM })

const memory = (lines: string[], body = 'Body.'): string => `---\n${lines.join('\n')}\n---\n\n${body}\n`

function file(scope: AuditedFile['scope'], path: string, content: string): AuditedFile {
  return { scope, path, content }
}

describe('memoryTokens and nearDuplicateScore', () => {
  test('names, descriptions and file stems compare without accents, plurals or stopwords', () => {
    const tokens = memoryTokens('/x/runtime-deps-review.md', 'runtimeDepsReview', 'New runtime dependencies need a review in #deps')
    expect([...tokens].sort()).toEqual(['dependency', 'deps', 'need', 'new', 'review', 'runtime'])
    expect([...memoryTokens('/x/a.md', null, 'Respostas em português')]).toEqual(['resposta', 'portugue'])
  })

  test('one fact restated scores past the threshold; two facts on one subject do not', () => {
    const a = memoryTokens('/t/notes-sc-14.md', 'notes-sc-14', 'adding a runtime dependency needs a review in the #deps channel first')
    const b = memoryTokens('/t/runtime-deps-review.md', 'runtime-deps-review', 'new runtime dependencies need a review in #deps before landing')
    expect(nearDuplicateScore(a, b)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN)
    const c = memoryTokens('/t/deps-lockfile.md', 'deps-lockfile', 'the lockfile is committed and bun install --frozen-lockfile runs in CI')
    expect(nearDuplicateScore(a, c)).toBeLessThan(NEAR_DUPLICATE_MIN)
  })

  test('an empty side scores 0, and a terse memory inside a fuller one still scores', () => {
    expect(nearDuplicateScore(new Set(), new Set(['a']))).toBe(0)
    const terse = new Set(['answer', 'portuguese'])
    const full = new Set(['user', 'brazilian', 'answer', 'portuguese', 'every', 'project', 'language'])
    expect(nearDuplicateScore(terse, full)).toBe(0.8)
  })

  test('similarMemories ranks the hits, best first, and drops the rest', () => {
    const hits = similarMemories(new Set(['a', 'b', 'c']), [
      { id: 'half', tokens: new Set(['a', 'x', 'y', 'z']) },
      { id: 'same', tokens: new Set(['a', 'b', 'c']) },
      { id: 'most', tokens: new Set(['a', 'b', 'q']) },
    ])
    expect(hits.map(h => h.memory.id)).toEqual(['same', 'most'])
  })
})

describe('findHygieneFindings', () => {
  test('a near-duplicate pair is reported once, across scopes, with its score', () => {
    const found = findHygieneFindings(
      [
        file('global', `${GLOBAL}user-language.md`, memory(['name: user-language', 'description: the user wants every answer in Portuguese', 'type: user'])),
        file('private', `${PRIVATE}answers-in-portuguese.md`, memory(['name: answers-in-portuguese', 'description: every answer in Portuguese', 'type: feedback'])),
        file('team', `${TEAM}deps-lockfile.md`, memory(['name: deps-lockfile', 'description: the lockfile is committed', 'type: project'])),
      ],
      dirs,
    )
    const pairs = found.filter(f => f.kind === 'near-duplicate')
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({
      scope: 'global',
      path: `${GLOBAL}user-language.md`,
      other: { scope: 'private', path: `${PRIVATE}answers-in-portuguese.md` },
    })
  })

  test('a user memory outside the global dir is misplaced while the global dir is on, not when it is off', () => {
    const files = [file('private', `${PRIVATE}user-role.md`, memory(['name: user-role', 'description: the user is a data scientist', 'type: user']))]
    expect(findHygieneFindings(files, dirs).map(f => f.kind)).toEqual(['misplaced-type'])
    expect(findHygieneFindings(files, testMemoryDirs({ private: PRIVATE, team: TEAM }))).toEqual([])
  })

  test('contradicts: is an open contradiction naming its targets, as a list or one name', () => {
    const found = findHygieneFindings(
      [
        file('team', `${TEAM}timeout-b.md`, memory(['name: timeout-b', 'description: b', 'type: project', 'contradicts:', '  - timeout-a', '  - timeout-c'])),
        file('team', `${TEAM}timeout-c.md`, memory(['name: timeout-c', 'description: c', 'type: project', 'contradicts: timeout-a'])),
      ],
      dirs,
    )
    expect(found.filter(f => f.kind === 'open-contradiction').map(f => ('targets' in f ? f.targets : []))).toEqual([['timeout-a', 'timeout-c'], ['timeout-a']])
  })

  test('an index over its cap is reported with what loads without its hook; one within it is not', () => {
    const line = (n: number) => `- [Note ${n}](note-${n}.md) — ${'a hook that carries far too much of the memory into the index '.repeat(3)}`
    const over = Array.from({ length: 150 }, (_, i) => line(i)).join('\n')
    const found = findHygieneFindings([file('team', `${TEAM}MEMORY.md`, over), file('private', `${PRIVATE}MEMORY.md`, line(1))], dirs)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'index-over-cap', path: `${TEAM}MEMORY.md`, lines: 150 })
    expect((found[0] as { shortened: number }).shortened).toBeGreaterThan(0)
  })

  test('a memory past OVERSIZE_BYTES is oversize; an index is never one', () => {
    const big = memory(['name: big', 'description: a profile', 'type: feedback'], 'x'.repeat(OVERSIZE_BYTES))
    const found = findHygieneFindings([file('private', `${PRIVATE}big.md`, big)], dirs)
    expect(found.map(f => f.kind)).toEqual(['oversize'])
  })
})

describe('isMemoryHygieneEnabled', () => {
  const saved = process.env.CLAUDIN_MEMORY_HYGIENE
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
    else process.env.CLAUDIN_MEMORY_HYGIENE = saved
  })

  test('is on by default, off under CLAUDIN_MEMORY_HYGIENE=0', () => {
    delete process.env.CLAUDIN_MEMORY_HYGIENE
    expect(isMemoryHygieneEnabled()).toBe(true)
    process.env.CLAUDIN_MEMORY_HYGIENE = '0'
    expect(isMemoryHygieneEnabled()).toBe(false)
  })
})
