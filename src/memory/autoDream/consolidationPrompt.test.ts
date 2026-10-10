import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { testMemoryDirs } from 'src/memory/memdir/__testutils__/memoryDirs.js'
import { TEAM_CATEGORIES } from 'src/memory/memdir/memoryTypes.js'

const TRANSCRIPTS = '/home/u/.claudin/projects/-repo'
const DIRS = testMemoryDirs({ private: '/repo/.claudin/memory/', team: '/repo/.claudin/memory/team/' })
const GLOBAL_DIRS = testMemoryDirs({
  private: '/repo/.claudin/memory/',
  team: '/repo/.claudin/memory/team/',
  global: '/home/u/.claudin/memory/',
})

describe('buildConsolidationPrompt', () => {
  test('files categories into the team dir and names the index sections', () => {
    const prompt = buildConsolidationPrompt(DIRS, TRANSCRIPTS, '')
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
    const prompt = buildConsolidationPrompt(DIRS, TRANSCRIPTS, 'DIGEST-BODY')
    const decisionSources = prompt.indexOf('**Decision sources**')
    const dailyLogs = prompt.indexOf('**Daily logs**')
    expect(decisionSources).toBeGreaterThan(0)
    expect(decisionSources).toBeLessThan(dailyLogs)
    expect(prompt).toContain('## Additional context\n\nDIGEST-BODY')
  })

  test("defers each type's scope to the system prompt's # Memory section", () => {
    const prompt = buildConsolidationPrompt(DIRS, TRANSCRIPTS, '')
    expect(prompt).toContain(
      "write or update a memory file in the directory its type's scope names — the `# Memory` section of your system prompt is the source of truth for that",
    )
    expect(prompt).toContain('- the private dir `/repo/.claudin/memory`, at its top level')
  })

  describe('with the global dir', () => {
    const prompt = buildConsolidationPrompt(GLOBAL_DIRS, TRANSCRIPTS, '')

    test('names it, and says it is append-only', () => {
      expect(prompt).toContain(
        '- the global dir `/home/u/.claudin/memory`, shared by every project — add to it only (below)',
      )
      expect(prompt).toContain(
        'add memories and add to them there, but never delete, shrink or rewrite one, nor remove a line from its index',
      )
      expect(prompt).toContain('A global memory this project contradicts stays as it is — name it in your summary instead.')
    })

    test('reads its index beside the project ones, and only adds lines to it', () => {
      expect(prompt).toContain(
        '— the private one and `/repo/.claudin/memory/team/MEMORY.md` and `/home/u/.claudin/memory/MEMORY.md`',
      )
      expect(prompt).not.toContain('//MEMORY.md')
      expect(prompt).toContain("The pruning below applies to this project's indexes only: in the global one, only add lines.")
    })

    test('the deleting and contradiction-resolving lines exempt it', () => {
      expect(prompt).toContain('- Deleting contradicted facts (outside the global dir) — if today')
      expect(prompt).toContain(
        '- Resolve contradictions — if two files disagree, fix the wrong one, unless it is a global memory: name that one in your summary',
      )
    })

    test('without it the prompt never says "global"', () => {
      const off = buildConsolidationPrompt(DIRS, TRANSCRIPTS, 'X')
      expect(off).not.toContain('global')
      expect(off).toContain('- Deleting contradicted facts — if today')
      expect(off).toContain('- Resolve contradictions — if two files disagree, fix the wrong one\n')
    })

    test('both dream entry points hand it the session dirs, and the auto-dream gate is append-only on global', () => {
      // Asserted on the SOURCE: the auto-dream runner needs a forked agent and
      // /dream a command context, neither of which this file builds.
      for (const rel of ['./autoDream.ts', '../../commands/dream/dream.ts']) {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
        expect(src).toContain('buildConsolidationPrompt(getMemoryDirs(), transcriptDir, extra)')
      }
      const autoDream = readFileSync(new URL('./autoDream.ts', import.meta.url), 'utf8')
      expect(autoDream).toContain("canUseTool: createMemoryCanUseTool(['global'])")
    })
  })
})
