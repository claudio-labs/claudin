import { describe, expect, test } from 'bun:test'
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { buildMemoryTidyPrompt } from 'src/commands/memory/tidyPrompt.js'

const PRIVATE_ROOT = '/repo/.claudin/memory'
const TEAM_ROOT = '/repo/.claudin/memory/team'
const MAX_KB = Math.round(MAX_ENTRYPOINT_BYTES / 1024)

describe('buildMemoryTidyPrompt', () => {
  test('includes the private memory root and orient step', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
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
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
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
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
    expect(prompt).toContain('NOT a rewrite')
    expect(prompt).toContain('Remove only the lines pointing at files you deleted')
    expect(prompt).toContain('byte-for-byte as it was')
    expect(prompt).toContain('- [Title](file.md) — one-line hook')
    expect(prompt).toContain(`${MAX_ENTRYPOINT_LINES} lines`)
    expect(prompt).toContain(`~${MAX_KB}KB`)
  })

  test('deletion goes through rm (human permission gate)', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
    expect(prompt).toContain('`rm`')
    expect(prompt).toContain('permission prompt')
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
    // Warns that team edits are git-tracked and reach the team on commit
    expect(prompt).toContain('reach the team on the next commit')
    expect(prompt).toContain('skip subdirectories other than the team dir')
  })

  test('requires a final report including ambiguous, conflicts, and stale buckets', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)
    expect(prompt).toContain('Ambiguous pairs left alone')
    expect(prompt).toContain('Conflicts noted')
    expect(prompt).toContain('Stale or broken observed')
    expect(prompt).toContain('a tidy run that changes nothing is a correct outcome')
  })

  test('global-off: the prompt is the one that always shipped', () => {
    expect(buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT, null)).toBe(
      buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT),
    )
    expect(buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT)).not.toContain('Global memory')
  })

  test('global-on: tidied by the same steps, never merged across, deletions reach every project', () => {
    const prompt = buildMemoryTidyPrompt(PRIVATE_ROOT, TEAM_ROOT, '/home/u/.claudin/memory/')
    expect(prompt).toContain('## Global memory')
    expect(prompt).toContain('/home/u/.claudin/memory/MEMORY.md')
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).toContain("Moving a private memory to the global dir is `/memory sort`'s job, not tidy's.")
    expect(prompt).toContain('a deletion here takes the memory away from all of them')
    expect(prompt).toContain('- Never merge across the global ↔ private/team boundary.')
    expect(prompt).toContain('(and the team and global indexes if applicable)')
  })
})
