import { afterEach, describe, expect, test } from 'bun:test'
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

  test('a drifted memory is traced through the transcript of the session that wrote it', () => {
    expect(buildConsolidationPrompt(DIRS, TRANSCRIPTS, '')).toContain(
      `The digest names the memories each session wrote: when one looks drifted, that session's transcript (the \`.jsonl\` in \`${TRANSCRIPTS}\` whose name starts with its id) holds why it was written`,
    )
  })

  test('asks for an expires: date on a fact with a natural end', () => {
    expect(buildConsolidationPrompt(DIRS, TRANSCRIPTS, '')).toContain(
      'a freeze, a deadline, a rotation, a temporary workaround — `expires: YYYY-MM-DD` in its frontmatter, the last day it holds',
    )
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
        '- Resolve contradictions — if two files disagree, fix the wrong one, unless it is a global memory: add `contradicts:` to it instead (an Edit that only adds the key), and name it in your summary',
      )
      expect(prompt).toContain('never a `MEMORY.md`, and nothing in the global dir')
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
      expect(autoDream).toContain("canUseTool: createMemoryCanUseTool(['global'], { patch: prune ? 'prune' : 'none' })")
    })
  })

  // memoryHygiene.ts: the dream prunes, decides a disagreement from the code
  // and marks what nothing settles; under CLAUDIN_MEMORY_HYGIENE=0 the prompt
  // is the one before it.
  describe('memory hygiene', () => {
    const saved = process.env.CLAUDIN_MEMORY_HYGIENE
    afterEach(() => {
      if (saved === undefined) delete process.env.CLAUDIN_MEMORY_HYGIENE
      else process.env.CLAUDIN_MEMORY_HYGIENE = saved
    })

    test('on, the dream deletes with Patch within its limits and marks an unsettled contradiction', () => {
      delete process.env.CLAUDIN_MEMORY_HYGIENE
      const prompt = buildConsolidationPrompt(GLOBAL_DIRS, TRANSCRIPTS, '')
      expect(prompt).toContain('delete the files themselves with a Patch `*** Delete File:`')
      expect(prompt).toContain('in the private dir, only a memory you merged into another, in the Patch that writes that survivor')
      expect(prompt).toContain('never delete to make room in an index')
      expect(prompt).toContain('never from which file is newer')
      expect(prompt).toContain('mark one with `contradicts:`')
      expect(prompt).toContain('fold that into the decision or memory it supports, then delete the snapshot (outside the global dir)')
    })

    test('off, none of it is said and the old global line is back', () => {
      process.env.CLAUDIN_MEMORY_HYGIENE = '0'
      const prompt = buildConsolidationPrompt(GLOBAL_DIRS, TRANSCRIPTS, '')
      expect(prompt).not.toContain('*** Delete File:')
      expect(prompt).not.toContain('contradicts:')
      expect(prompt).toContain('unless it is a global memory: name that one in your summary')
    })
  })
})
