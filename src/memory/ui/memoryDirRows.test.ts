import { describe, expect, test } from 'bun:test'
import { join } from 'path'

import type { MemoryHeader } from 'src/memory/memdir/memoryScan.js'
import {
  buildMemoryDirRows,
  encodeBrowseValue,
  parseBrowseValue,
  removeIndexPointer,
  TIDY_VALUE,
} from 'src/memory/ui/memoryDirRows.js'

const PRIVATE_DIR = '/repo/.claudin/memory'
const INDEX_PATH = join(PRIVATE_DIR, 'MEMORY.md')

// 2026-09-09T12:00:00Z, so ages render deterministically relative to `now`.
const NOW = 1_757_419_200_000
const DAY = 86_400_000

function header(overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  const filename = overrides.filename ?? 'a-memory.md'
  return {
    filename,
    filePath: join(PRIVATE_DIR, filename),
    mtimeMs: NOW - DAY,
    description: 'a description',
    type: 'project',
    ...overrides,
  }
}

describe('buildMemoryDirRows', () => {
  test('pins the index first and keeps the scan order after it', () => {
    const rows = buildMemoryDirRows(
      [
        header({ filename: 'newest.md', mtimeMs: NOW - DAY }),
        header({ filename: 'older.md', mtimeMs: NOW - 12 * DAY }),
      ],
      { indexPath: INDEX_PATH, indexExists: true },
    )

    expect(rows.map(r => r.value)).toEqual([
      INDEX_PATH,
      join(PRIVATE_DIR, 'newest.md'),
      join(PRIVATE_DIR, 'older.md'),
    ])
    expect(rows[0]!.isIndex).toBe(true)
    expect(rows[1]!.isIndex).toBe(false)
  })

  test('drops entries from subdirectories — the team dir is nested in the private one', () => {
    const rows = buildMemoryDirRows(
      [
        header({
          filename: join('team', 'shared.md'),
          filePath: join(PRIVATE_DIR, 'team', 'shared.md'),
        }),
        header({ filename: 'mine.md' }),
      ],
      { indexPath: INDEX_PATH, indexExists: true },
    )

    expect(rows.map(r => r.value)).toEqual([
      INDEX_PATH,
      join(PRIVATE_DIR, 'mine.md'),
    ])
  })

  test('includeNested keeps them when the caller wants a flat view', () => {
    const rows = buildMemoryDirRows(
      [
        header({
          filename: join('team', 'shared.md'),
          filePath: join(PRIVATE_DIR, 'team', 'shared.md'),
        }),
      ],
      { indexPath: INDEX_PATH, indexExists: false, includeNested: true },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBe(join(PRIVATE_DIR, 'team', 'shared.md'))
  })

  test('an empty dir with an index yields the index row alone', () => {
    const rows = buildMemoryDirRows([], {
      indexPath: INDEX_PATH,
      indexExists: true,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.isIndex).toBe(true)
  })

  test('an empty dir with no index yields no rows', () => {
    expect(
      buildMemoryDirRows([], { indexPath: INDEX_PATH, indexExists: false }),
    ).toEqual([])
  })

  test('type tags pad to a common width so the name column aligns', () => {
    const rows = buildMemoryDirRows(
      [
        header({ filename: 'a.md', type: 'user' }),
        header({ filename: 'b.md', type: 'reference' }),
        header({ filename: 'c.md', type: undefined }),
      ],
      { indexPath: INDEX_PATH, indexExists: true },
    )

    // Every name starts at the same column: the index row and the type-less
    // memory pad with blanks, and the longest tag still leaves a gap.
    const TAG_WIDTH = 13
    for (const row of rows) {
      expect(row.label.slice(0, TAG_WIDTH)).toHaveLength(TAG_WIDTH)
      expect(row.label.charAt(TAG_WIDTH)).not.toBe(' ')
    }
    expect(rows[1]!.label.startsWith('[user]')).toBe(true)
    expect(rows[2]!.label.startsWith('[reference]  ')).toBe(true)
    expect(rows[3]!.label.trimStart()).toBe(rows[3]!.label.slice(TAG_WIDTH))
  })

  test('the row carries the frontmatter description, and a missing one is absent', () => {
    const rows = buildMemoryDirRows(
      [
        header({ filename: 'a.md', description: 'why it matters' }),
        header({ filename: 'b.md', description: null }),
      ],
      { indexPath: INDEX_PATH, indexExists: false },
    )

    expect(rows[0]!.description).toBe('why it matters')
    expect(rows[1]!.description).toBeUndefined()
  })

  test('a long description is clipped to one line so the row stays one row', () => {
    const long =
      'Token/cost census of 2026-09-04..09-08 sessions (1,044 calls, ~$170), ' +
      'what was fixed from it, and the probe results that decided each promotion'
    const rows = buildMemoryDirRows(
      [header({ filename: 'a.md', description: long })],
      { indexPath: INDEX_PATH, indexExists: false },
    )

    expect(rows[0]!.description!.length).toBeLessThanOrEqual(60)
    expect(rows[0]!.description!.endsWith('…')).toBe(true)
    expect(rows[0]!.description!.startsWith('Token/cost census')).toBe(true)
  })

  test('a multi-line description is flattened before clipping', () => {
    const rows = buildMemoryDirRows(
      [header({ filename: 'a.md', description: 'first\n  second   third' })],
      { indexPath: INDEX_PATH, indexExists: false },
    )

    expect(rows[0]!.description).toBe('first second third')
  })

  test('the label drops the .md extension and carries an age', () => {
    const rows = buildMemoryDirRows(
      [header({ filename: 'cache-ttl.md', mtimeMs: Date.now() - 4 * DAY })],
      { indexPath: INDEX_PATH, indexExists: false },
    )

    expect(rows[0]!.label).toContain('cache-ttl')
    expect(rows[0]!.label).not.toContain('.md')
    expect(rows[0]!.label).toContain('4d ago')
  })
})

describe('browse row values', () => {
  test('round trips the title and the team flag', () => {
    const target = {
      dir: '/repo/.claudin/memory/team/',
      title: 'Team memory',
      isTeamDir: true,
    }

    expect(parseBrowseValue(encodeBrowseValue(target))).toEqual(target)
  })

  test('a private dir round trips with the flag off', () => {
    const target = {
      dir: PRIVATE_DIR,
      title: 'Private memory',
      isTeamDir: false,
    }

    expect(parseBrowseValue(encodeBrowseValue(target))).toEqual(target)
  })

  test('a path holding the field separator keeps its tail', () => {
    const dir = `/repo/od\u001fd/memory`
    const parsed = parseBrowseValue(
      encodeBrowseValue({ dir, title: 'Odd', isTeamDir: false }),
    )

    expect(parsed?.dir).toBe(dir)
    expect(parsed?.title).toBe('Odd')
  })

  test('every non-browse value parses as null', () => {
    expect(parseBrowseValue(TIDY_VALUE)).toBeNull()
    expect(parseBrowseValue('/repo/.claudin/memory/a-memory.md')).toBeNull()
    // A truncated sentinel is not a target either.
    expect(parseBrowseValue('__browse_dir__1')).toBeNull()
    expect(parseBrowseValue('__browse_dir__1\u001fTeam memory')).toBeNull()
  })
})

describe('removeIndexPointer', () => {
  const INDEX = [
    '# Team Memory',
    '',
    '> Durable gotchas live in `.claudin/rules/`.',
    '',
    '## Conventions',
    '- [Doomed idea](doomed-idea.md) — why it was rejected',
    '- [Adding a preset](../../skills/add-provider-preset/SKILL.md) — the recipe',
    '',
    '## Repo health',
    '- [Typecheck backlog](typecheck-backlog-shape.md) — the ratchet',
  ].join('\n')

  test('removes only the pointer whose link target matches', () => {
    const result = removeIndexPointer(INDEX, 'doomed-idea.md')

    expect(result).not.toContain('doomed-idea.md')
    expect(result).toContain('## Conventions')
    expect(result).toContain('../../skills/add-provider-preset/SKILL.md')
    expect(result).toContain('typecheck-backlog-shape.md')
    expect(result).toContain('# Team Memory')
    expect(result).toContain('> Durable gotchas live in `.claudin/rules/`.')
  })

  test('leaves a section heading behind rather than guessing it is dead', () => {
    const result = removeIndexPointer(INDEX, 'typecheck-backlog-shape.md')

    expect(result).toContain('## Repo health')
    expect(result).not.toContain('typecheck-backlog-shape.md')
  })

  test('a relative-path link is not matched by its basename', () => {
    // Deleting a memory named SKILL.md must not take out a pointer aimed at a
    // different directory's SKILL.md.
    expect(removeIndexPointer(INDEX, 'SKILL.md')).toBe(INDEX)
  })

  test('returns the input unchanged when nothing points at the file', () => {
    expect(removeIndexPointer(INDEX, 'never-indexed.md')).toBe(INDEX)
  })

  test('removes every pointer when the file is listed twice', () => {
    const doubled = [
      '- [Once](dup.md) — first',
      '- [Twice](dup.md) — second',
      '- [Other](other.md) — kept',
    ].join('\n')

    expect(removeIndexPointer(doubled, 'dup.md')).toBe(
      '- [Other](other.md) — kept',
    )
  })
})
