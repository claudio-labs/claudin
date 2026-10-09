import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
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

  describe('with the global dir', () => {
    const GLOBAL = '/home/u/.claudin/memory/'
    const RULE =
      'never delete a global memory, never shrink one, and never remove a line from its index — what looks stale here may still hold in another project'

    test('with a team root: user memories and global feedback go there, project facts stay', () => {
      const prompt = buildConsolidationPrompt(ROOT, TRANSCRIPTS, '', '/repo/.claudin/memory/team/', GLOBAL)
      expect(prompt).toContain(
        '- who the user is (`type: user`), or feedback that holds in any project (how they want answers, plans or reviews) — in the global dir `/home/u/.claudin/memory`, shared by every project',
      )
      expect(prompt).toContain(
        "- a private fact about this project — feedback that names its files, commands or conventions, private project context — at the top level of `/repo/.claudin/memory/`",
      )
      expect(prompt).toContain(RULE)
      expect(prompt).toContain('— the private one and `/repo/.claudin/memory/team/MEMORY.md` and `/home/u/.claudin/memory/MEMORY.md`')
      expect(prompt).toContain('in the global one, add and update lines, never remove one.')
    })

    test('without a team root it still says where each goes, and never to prune the global dir', () => {
      const prompt = buildConsolidationPrompt(ROOT, TRANSCRIPTS, '', null, GLOBAL)
      expect(prompt).toContain(
        'Who the user is (`type: user`) and feedback that holds in any project go in the global dir `/home/u/.claudin/memory`',
      )
      expect(prompt).toContain(RULE)
      expect(prompt).toContain('— the private one and `/home/u/.claudin/memory/MEMORY.md`')
    })

    test('without it the prompt is the one that always shipped', () => {
      for (const team of [null, '/repo/.claudin/memory/team/']) {
        expect(buildConsolidationPrompt(ROOT, TRANSCRIPTS, 'X', team, null)).toBe(
          buildConsolidationPrompt(ROOT, TRANSCRIPTS, 'X', team),
        )
        expect(buildConsolidationPrompt(ROOT, TRANSCRIPTS, 'X', team)).not.toContain('global')
      }
    })

    test('both dream entry points hand it the global dir while it is on', () => {
      // Asserted on the SOURCE: the auto-dream runner needs a forked agent and
      // /dream a command context, neither of which this file builds.
      for (const rel of ['./autoDream.ts', '../../commands/dream/dream.ts']) {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
        expect(src).toContain('const globalRoot = isGlobalMemoryEnabled() ? getGlobalMemPath() : null')
        expect(src).toMatch(/buildConsolidationPrompt\(\s*memoryRoot,\s*transcriptDir,\s*extra,\s*teamRoot,\s*globalRoot,\s*\)/)
      }
    })
  })
})
