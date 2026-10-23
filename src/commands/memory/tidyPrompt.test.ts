import { describe, expect, test } from 'bun:test'
import {
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { buildMemoryTidyPrompt } from 'src/commands/memory/tidyPrompt.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'

const PRIVATE_ROOT = '/repo/.claudin/memory'
const TEAM_ROOT = '/repo/.claudin/memory/team'
const GLOBAL_ROOT = '/home/u/.claudin/memory'
const MAX_KB = Math.round(MAX_ENTRYPOINT_BYTES / 1024)
const DIRS = testMemoryDirs({ private: PRIVATE_ROOT, team: TEAM_ROOT })

describe('buildMemoryTidyPrompt — audit findings', () => {
  const expired = { kind: 'expired' as const, scope: 'team' as const, path: `${TEAM_ROOT}/freeze.md`, expires: '2026-09-30' }
  const secret = { kind: 'secret' as const, path: `${TEAM_ROOT}/bugs/x.md`, labels: ['GitHub PAT'] }

  test('no findings: the prompt is exactly what it was', () => {
    expect(buildMemoryTidyPrompt(DIRS, [])).toBe(buildMemoryTidyPrompt(DIRS))
    expect(buildMemoryTidyPrompt(DIRS)).not.toContain('Found before you started')
  })

  test('each finding is listed, to report and never to fix, with its own report heading', () => {
    const prompt = buildMemoryTidyPrompt(DIRS, [secret, expired])
    expect(prompt).toContain('## Found before you started')
    expect(prompt).toContain(`- Secret-shaped content (GitHub PAT): \`${TEAM_ROOT}/bugs/x.md\``)
    expect(prompt).toContain(`- Past its \`expires:\` date (2026-09-30): \`${TEAM_ROOT}/freeze.md\``)
    expect(prompt).toContain('Do not delete, rewrite or re-date any of them here.')
    expect(prompt).toContain('never repeat the matched text')
    const report = prompt.slice(prompt.indexOf('## Step 5'))
    expect(report).toContain('- **Secret-shaped (team)**')
    expect(report).toContain('- **Expired, for review**')
  })

  test('only an expired memory: no secret wording', () => {
    const prompt = buildMemoryTidyPrompt(DIRS, [expired])
    expect(prompt).not.toContain('Secret-shaped')
    expect(prompt).not.toContain('never repeat the matched text')
  })

  test('hidden characters are listed with their own report heading', () => {
    const hidden = { kind: 'hidden-text' as const, path: `${TEAM_ROOT}/x.md`, labels: ['bidi control'] }
    const prompt = buildMemoryTidyPrompt(DIRS, [hidden])
    expect(prompt).toContain(`- Hidden characters (bidi control): \`${TEAM_ROOT}/x.md\``)
    expect(prompt.slice(prompt.indexOf('## Step 5'))).toContain('- **Hidden characters (team)**')
    expect(prompt).not.toContain('Secret-shaped')
  })
})

describe('buildMemoryTidyPrompt', () => {
  test('includes the private memory root and orient step', () => {
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).toContain(PRIVATE_ROOT)
    expect(prompt).toContain(`${PRIVATE_ROOT}/MEMORY.md`)
    expect(prompt).toContain('full contents, not just frontmatter')
  })

  test('normalizes a trailing separator instead of rendering double slashes', () => {
    // MemoryDir roots carry a trailing sep (the fixture adds it, as getMemoryDirs() does)
    expect(DIRS[0]!.root).toBe(`${PRIVATE_ROOT}/`)
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).toContain(`${PRIVATE_ROOT}/MEMORY.md`)
    expect(prompt).toContain(`${TEAM_ROOT}/MEMORY.md`)
    expect(prompt).not.toContain('//MEMORY.md')
  })

  test('states the conservative hard rules', () => {
    const prompt = buildMemoryTidyPrompt(DIRS)
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
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).toContain('NOT a rewrite')
    expect(prompt).toContain('Remove only the lines pointing at files you deleted')
    expect(prompt).toContain('byte-for-byte as it was')
    expect(prompt).toContain('- [Title](file.md) — one-line hook')
    expect(prompt).toContain(`${MAX_ENTRYPOINT_LINES} lines`)
    expect(prompt).toContain(`~${MAX_KB}KB`)
  })

  test('deletion goes through rm (human permission gate)', () => {
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).toContain('`rm`')
    expect(prompt).toContain('permission prompt')
  })

  test('team-on: team instructions with structure preservation', () => {
    const prompt = buildMemoryTidyPrompt(DIRS)
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
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).toContain('Ambiguous pairs left alone')
    expect(prompt).toContain('Conflicts noted')
    expect(prompt).toContain('Stale or broken observed')
    expect(prompt).toContain('a tidy run that changes nothing is a correct outcome')
  })

  test('global-off: the prompt never mentions a global dir', () => {
    const prompt = buildMemoryTidyPrompt(DIRS)
    expect(prompt).not.toContain('Global memory')
    expect(prompt).not.toContain('global')
    expect(prompt).toContain('(and the team index if applicable)')
  })

  test('global-on: tidied by the same steps, never merged across, deletions reach every project', () => {
    const prompt = buildMemoryTidyPrompt(
      testMemoryDirs({ private: PRIVATE_ROOT, team: TEAM_ROOT, global: GLOBAL_ROOT }),
    )
    expect(prompt).toContain('## Global memory')
    expect(prompt).toContain('/home/u/.claudin/memory/MEMORY.md')
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).toContain("Moving a private memory to the global dir is `/memory sort`'s job, not tidy's.")
    expect(prompt).toContain('a deletion here takes the memory away from all of them')
    expect(prompt).toContain('- Never merge across the global ↔ private/team boundary.')
    expect(prompt).toContain('(and the team and global indexes if applicable)')
  })
})
