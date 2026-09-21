import { describe, expect, test } from 'bun:test'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { TEAM_CATEGORIES } from 'src/memory/memdir/memoryTypes.js'

const ROOT = '/repo/.claudin/memory/'
const TRANSCRIPTS = '/home/u/.claudin/projects/-repo'

describe('buildConsolidationPrompt', () => {
  test('private-only (no team root) keeps the top-level-only rule and no categories', () => {
    const prompt = buildConsolidationPrompt(ROOT, TRANSCRIPTS, '')
    expect(prompt).toContain('at the top level of the memory directory')
    expect(prompt).not.toContain('## Team categories')
    expect(prompt).not.toContain('git-tracked')
  })

  test('with a team root it files categories into the team dir and names the index sections', () => {
    const prompt = buildConsolidationPrompt(
      ROOT,
      TRANSCRIPTS,
      '',
      '/repo/.claudin/memory/team/',
    )
    expect(prompt).toContain('## Team categories')
    for (const category of TEAM_CATEGORIES) {
      expect(prompt).toContain(`<dir>${category.dir}/</dir>`)
      expect(prompt).toContain(`\`## ${category.section}\``)
    }
    expect(prompt).toContain('/repo/.claudin/memory/team/MEMORY.md')
    expect(prompt).not.toContain('team//')
    expect(prompt).toContain('that commit is the review')
    expect(prompt).toContain('naming any team file you created')
  })

  test('points Phase 2 at the digest as the first source', () => {
    const prompt = buildConsolidationPrompt(ROOT, TRANSCRIPTS, 'DIGEST-BODY')
    const decisionSources = prompt.indexOf('**Decision sources**')
    const dailyLogs = prompt.indexOf('**Daily logs**')
    expect(decisionSources).toBeGreaterThan(0)
    expect(decisionSources).toBeLessThan(dailyLogs)
    expect(prompt).toContain('## Additional context\n\nDIGEST-BODY')
  })
})
