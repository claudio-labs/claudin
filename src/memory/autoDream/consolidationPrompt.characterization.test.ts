/**
 * Characterization of the dream prompt (consolidationPrompt.ts).
 *
 * The rewrite writes its own prose, so nothing here matches a sentence. What
 * is pinned are the facts the prompt has to carry (paths, file names, limits,
 * formats), the shared sections it must quote verbatim, where the caller's
 * run-specific text lands, and how the team variant differs.
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { buildConsolidationPrompt } from 'src/memory/autoDream/consolidationPrompt.js'
import { checkoutRoot } from 'src/memory/extract/__testutils__/extractionHarness.js'
import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from 'src/memory/memdir/memdir.js'
import { renderTeamCategoriesXml, TEAM_CATEGORIES } from 'src/memory/memdir/memoryTypes.js'

const MEMORY = '/work/shop/.claudin/memory/'
const TRANSCRIPTS = '/home/dev/.claudin/projects/-work-shop'
const TEAM = '/work/shop/.claudin/memory/team'

const privatePrompt = (extra = '') => buildConsolidationPrompt(MEMORY, TRANSCRIPTS, extra)
const teamPrompt = (extra = '', teamRoot = `${TEAM}/`) =>
  buildConsolidationPrompt(MEMORY, TRANSCRIPTS, extra, teamRoot)

const VARIANTS: Array<[string, () => string]> = [
  ['private only', () => privatePrompt()],
  ['with a team directory', () => teamPrompt()],
]

/** Positions of `needles` in `text`, failing on any that is missing. */
function positions(text: string, needles: string[]): number[] {
  return needles.map(needle => {
    const at = text.indexOf(needle)
    expect({ needle, found: at >= 0 }).toEqual({ needle, found: true })
    return at
  })
}

describe('buildConsolidationPrompt, the facts every variant states', () => {
  test.each(VARIANTS)('%s: where memory and the transcripts are', (_, build) => {
    const prompt = build()
    expect(prompt).toContain(`\`${MEMORY}\``)
    expect(prompt).toContain(DIR_EXISTS_GUIDANCE)
    expect(prompt).toContain(`\`${TRANSCRIPTS}\``)
    expect(prompt).toContain('JSONL')
  })

  test.each(VARIANTS)('%s: the narrow transcript search it suggests', (_, build) => {
    const prompt = build()
    expect(prompt).toContain(`${TRANSCRIPTS}/ --include="*.jsonl"`)
    expect(prompt).toMatch(/grep -rn "[^"]+" \S+ --include="\*\.jsonl" \| tail -50/)
  })

  test.each(VARIANTS)('%s: the other sources, the decision digest first', (_, build) => {
    const prompt = build()
    const [digest, logs] = positions(prompt, ['Additional context', 'logs/YYYY/MM/YYYY-MM-DD.md'])
    expect(digest!).toBeLessThan(logs!)
    positions(prompt, ['`logs/`', '`sessions/`', '`## Context`', '`## Agreed Decisions`', '`feat`', '`refactor`'])
  })

  test.each(VARIANTS)('%s: the index, its limits and its line format', (_, build) => {
    const prompt = build()
    positions(prompt, [
      `\`${ENTRYPOINT_NAME}\``,
      `${MAX_ENTRYPOINT_LINES} lines`,
      '~25KB',
      '~150 characters',
      '`- [Title](file.md) — one-line hook`',
      '~200 chars',
    ])
  })

  test.each(VARIANTS)('%s: four phases, orient, gather, consolidate, prune', (_, build) => {
    const prompt = build()
    const at = positions(prompt, ['Phase 1', 'Phase 2', 'Phase 3', 'Phase 4'])
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const titled = ['Orient', 'Gather', 'Consolidate', 'Prune'].map(word =>
      prompt.search(new RegExp(`Phase \\d\\D{0,6}${word}`)),
    )
    expect(titled.every(i => i >= 0)).toBe(true)
    expect([...titled].sort((a, b) => a - b)).toEqual(titled)
    expect(prompt).not.toContain('Phase 5')
  })

  test.each(VARIANTS)('%s: it ends by asking for a summary', (_, build) => {
    const tail = build().slice(-600)
    expect(tail).toMatch(/summary/i)
  })
})

describe('buildConsolidationPrompt, the run-specific text', () => {
  test('a non-empty extra is appended last, under its own heading', () => {
    const extra = 'Sessions to look at:\n- one\n- two'
    expect(privatePrompt(extra)).toBe(`${privatePrompt()}\n\n## Additional context\n\n${extra}`)
    expect(teamPrompt(extra)).toBe(`${teamPrompt()}\n\n## Additional context\n\n${extra}`)
  })

  test('an empty extra adds nothing', () => {
    expect(privatePrompt('')).not.toContain('## Additional context')
    expect(privatePrompt('').endsWith('\n')).toBe(false)
  })
})

describe('buildConsolidationPrompt without a team directory', () => {
  test('a missing team root is the same as null', () => {
    expect(buildConsolidationPrompt(MEMORY, TRANSCRIPTS, 'x')).toBe(
      buildConsolidationPrompt(MEMORY, TRANSCRIPTS, 'x', null),
    )
  })

  test('says nothing of a team, of categories or of git', () => {
    const prompt = privatePrompt()
    expect(prompt).not.toContain(renderTeamCategoriesXml().join('\n'))
    for (const category of TEAM_CATEGORIES) {
      expect(prompt).not.toContain(`\`## ${category.section}\``)
      expect(prompt).not.toContain(`<dir>${category.dir}/</dir>`)
    }
    expect(prompt).not.toMatch(/\bteam\b/i)
    expect(prompt).not.toMatch(/\bgit\b/)
  })

  test('files every memory at the top level of the memory directory', () => {
    expect(privatePrompt()).toMatch(/top level/)
  })
})

describe('buildConsolidationPrompt with a team directory', () => {
  test('names the team directory without its trailing separators, and its own index', () => {
    const cases: Array<[string, string]> = [
      [`${TEAM}/`, TEAM],
      [`${TEAM}///`, TEAM],
      [TEAM, TEAM],
      ['C:\\shop\\memory\\team\\', 'C:\\shop\\memory\\team'],
      ['C:\\shop\\memory\\team/\\', 'C:\\shop\\memory\\team'],
    ]
    for (const [given, shown] of cases) {
      const prompt = teamPrompt('', given)
      expect(prompt).toContain(`\`${shown}\``)
      expect(prompt).toContain(`\`${shown}/${ENTRYPOINT_NAME}\``)
      expect(prompt).not.toContain(`${shown}//`)
      expect(prompt).not.toContain(`${shown}\\/`)
    }
  })

  test('quotes the team categories verbatim and names each index section', () => {
    const prompt = teamPrompt()
    expect(prompt).toContain(renderTeamCategoriesXml().join('\n'))
    const sections = TEAM_CATEGORIES.map(category => `\`## ${category.section}\``)
    expect(prompt).toContain(sections.join(' / '))
  })

  test('shows a category link with its subdirectory, and keeps private facts in the private root', () => {
    const prompt = teamPrompt()
    expect(prompt).toContain('`(decisions/file.md)`')
    const privateRule = prompt.indexOf(`top level of \`${MEMORY}\``)
    expect(privateRule).toBeGreaterThan(0)
  })

  test('warns that the team directory is shared through git, so no secret goes there', () => {
    const prompt = teamPrompt()
    expect(prompt).toMatch(/git/)
    expect(prompt).toMatch(/secret/)
  })

  test('the closing summary asks to name the team files created', () => {
    expect(teamPrompt().slice(-400)).toMatch(/team file/)
    expect(privatePrompt().slice(-400)).not.toMatch(/team file/)
  })
})

describe('the wire proxy pairing', () => {
  test('scripts/bench/ab/wire-proxy.ts recognizes the dream prompt as a fork, in both variants', async () => {
    // The proxy tells a fork from the main loop by how the fork's prompt opens.
    const proxy = await import(join(checkoutRoot(), 'scripts', 'bench', 'ab', 'wire-proxy.ts'))
    const loop = { max_tokens: 8_000, tools: [{ name: 'Read' }, { name: 'Edit' }] }
    const task = { role: 'user', content: 'rename the exporter' }
    expect(proxy.requestKind({ ...loop, messages: [task] })).toBe('main')
    for (const prompt of [privatePrompt('digest'), teamPrompt('digest')]) {
      const forked = [task, { role: 'assistant', content: 'done' }, { role: 'user', content: prompt }]
      expect(proxy.requestKind({ ...loop, messages: forked })).toBe('other')
    }
  })
})
