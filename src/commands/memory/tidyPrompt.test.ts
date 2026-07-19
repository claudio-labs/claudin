import { describe, expect, test } from 'bun:test'
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'
import { buildMemoryTidyPrompt } from './tidyPrompt.js'

const PRIVATE_ROOT = '/repo/.claudin/memory'
const TEAM_ROOT = '/repo/.claudin/memory/team'
const MAX_KB = Math.round(MAX_ENTRYPOINT_BYTES / 1024)

describe('buildMemoryTidyPrompt', () => {
  test('includes the private memory root and orient step', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    expect(prompt).toContain(PRIVATE_ROOT)
    expect(prompt).toContain(`${PRIVATE_ROOT}/MEMORY.md`)
    expect(prompt).toContain('full contents, not just frontmatter')
  })

  test('normalizes a trailing separator instead of rendering double slashes', () => {
    // getAutoMemPath()/getTeamMemPath() return paths with trailing sep
    const prompt = buildMemoryTidyPrompt(`${PRIVATE_ROOT}/`, `${TEAM_ROOT}/`)
    expect(prompt).toContain(`${PRIVATE_ROOT}/MEMORY.md`)
    expect(prompt).toContain(`${TEAM_ROOT}/MEMORY.md`)
    expect(prompt).not.toContain('//MEMORY.md')
  })

  test('states the conservative hard rules', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    // No cross-boundary merges
    expect(prompt).toContain('Never merge across the private ↔ team boundary')
    // Ambiguous pairs are left alone
    expect(prompt).toContain('NOT duplicates — leave both untouched')
    // Partial overlap is not a duplicate (over-merge guard)
    expect(prompt).toContain('partially overlap')
    expect(prompt).toContain('facts X+Y')
    // Conflicts resolve to union, never silent choice
    expect(prompt).toContain('keep BOTH facts (union)')
    // Only duplicates are deleted
    expect(prompt).toContain('only confirmed duplicates')
    // Malformed frontmatter is skipped, not mangled
    expect(prompt).toContain('frontmatter is malformed, skip that file')
    // No new memories, no transcript digging, no topic reorganization
    expect(prompt).toContain('Never create new memory files')
    expect(prompt).toContain('do not look at transcripts')
    expect(prompt).toContain('do not reorganize by topic')
  })

  test('index update is surgical, not a rewrite, and cites caps from the constants', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    expect(prompt).toContain('NOT a rewrite')
    expect(prompt).toContain('Remove only the lines pointing at files you deleted')
    expect(prompt).toContain('byte-for-byte as it was')
    expect(prompt).toContain('- [Title](file.md) — one-line hook')
    expect(prompt).toContain(`${MAX_ENTRYPOINT_LINES} lines`)
    expect(prompt).toContain(`~${MAX_KB}KB`)
  })

  test('deletion goes through rm (human permission gate)', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    expect(prompt).toContain('`rm`')
    expect(prompt).toContain('permission prompt')
  })

  test('team-off: no team section and subdirectories are all skipped', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    expect(prompt).not.toContain('Team memory')
    expect(prompt).not.toContain(TEAM_ROOT)
    // The static "team dir handled separately" clause must not leak into a
    // team-off run — it would invite the agent into team/ without the rules.
    expect(prompt).toContain('skip all subdirectories')
    expect(prompt).not.toContain('team dir handled separately')
  })

  test('team-on: team instructions with structure preservation', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
    expect(prompt).toContain('## Team memory')
    expect(prompt).toContain(TEAM_ROOT)
    expect(prompt).toContain(`${TEAM_ROOT}/MEMORY.md`)
    expect(prompt).toContain('Never merge across the boundary')
    // The team index has header/sections the agent must not flatten
    expect(prompt).toContain('Preserve all of it')
    expect(prompt).toContain('Never reformat, reorder, or flatten')
    // Warns that team edits propagate via sync
    expect(prompt).toContain('propagate to the team via automatic sync')
    expect(prompt).toContain('skip subdirectories other than the team dir')
  })

  test('requires a final report including ambiguous, conflicts, and stale buckets', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, null)
    expect(prompt).toContain('Ambiguous pairs left alone')
    expect(prompt).toContain('Conflicts noted')
    expect(prompt).toContain('Stale or broken observed')
    expect(prompt).toContain('a tidy run that changes nothing is a correct outcome')
  })
})
