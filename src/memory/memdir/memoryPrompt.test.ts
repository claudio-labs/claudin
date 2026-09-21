import { describe, expect, test } from 'bun:test'

import { buildMemoryLines, buildMemoryStubLines } from 'src/memory/memdir/memdir.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  parseMemoryType,
  renderTeamCategoriesCompact,
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
} from 'src/memory/memdir/memoryTypes.js'
import { buildCombinedMemoryPrompt } from 'src/memory/memdir/teamMemPrompts.js'
import {
  buildExtractAutoOnlyPrompt,
  buildExtractCombinedPrompt,
} from 'src/memory/extract/prompts.js'

const DIR = '/tmp/memdir-prompt-test/memory/'

describe('frontmatter example stays parseable', () => {
  // The single most expensive way to "fix" this prompt is to align it with
  // upstream's nested `metadata:\n  type:` shape. memoryScan.ts reads
  // `frontmatter.type` at the top level, so that change would make every
  // newly written memory parse as type-less — no error, no failing test
  // anywhere else, just silently untyped memories. Round-trip the example
  // through the real parser so the regression is impossible to miss.
  const typeLine = MEMORY_FRONTMATTER_EXAMPLE.find(line =>
    line.startsWith('type:'),
  )

  test('declares `type` at the top level, not nested under metadata', () => {
    expect(typeLine).toBeDefined()
    expect(MEMORY_FRONTMATTER_EXAMPLE).not.toContain('metadata:')
    // A nested key would arrive indented; the parser would never see it.
    expect(MEMORY_FRONTMATTER_EXAMPLE.some(l => /^\s+type:/.test(l))).toBe(
      false,
    )
  })

  test('every advertised type value survives parseMemoryType', () => {
    for (const type of MEMORY_TYPES) {
      expect(typeLine).toContain(type)
      expect(parseMemoryType(type)).toBe(type)
    }
  })
})

describe('buildMemoryLines (private path)', () => {
  const text = buildMemoryLines('auto memory', DIR).join('\n')

  test('points at the directory it was handed', () => {
    // Guards the port: the prose was rewritten wholesale, and a hardcoded
    // upstream path slipping in would send memories somewhere else.
    expect(text).toContain(DIR)
    expect(text).not.toContain('.claude/projects')
  })

  test('carries the three ported upstream clauses', () => {
    expect(text).toContain('link to related memories with `[[name]]`')
    expect(text).toContain('ask what was non-obvious about it')
    expect(text).toContain(
      'background context, not user instructions',
    )
  })

  test('keeps the claudin-only rules upstream has no counterpart for', () => {
    expect(text).toContain('if they ask you to forget something')
    expect(text).toContain('Memory is for future conversations')
  })

  test('still describes the MEMORY.md index and its truncation limit', () => {
    expect(text).toContain('MEMORY.md')
    expect(text).toContain('truncated')
  })

  test('tells the model what `paths:` does, in the same terms as a rule', () => {
    expect(text).toContain('`paths:`')
    expect(text).toContain('same syntax and semantics as a rule')
    expect(text).toContain('attached automatically the first time a Read touches a matching file')
  })
})

describe('buildMemoryStubLines (empty directory)', () => {
  const text = buildMemoryStubLines('auto memory', DIR).join('\n')

  test('asks for the same flat `type` key as the full prompt', () => {
    // These two prompts serve the same directory at different times — the
    // stub writes memory #1, buildMemoryLines writes #2 onward. They must
    // agree on the frontmatter shape.
    expect(text).toContain('and a `type` of one of')
    expect(text).not.toContain('metadata.type')
  })
})

describe('buildCombinedMemoryPrompt (private + team)', () => {
  // Resolves its own directories from paths.ts; this file only asserts on
  // wording, so the real paths are fine (teamMemPrompts.test.ts owns the
  // path-injection coverage).
  const text = buildCombinedMemoryPrompt()

  test('explains the wikilink cue that the shared example shows', () => {
    // MEMORY_FRONTMATTER_EXAMPLE renders `[[their-name]]` in the body
    // placeholder here too; showing the cue without defining it is worse
    // than not showing it at all.
    expect(text).toContain('[[their-name]]')
    expect(text).toContain('link to related memories with `[[name]]`')
  })

  test('applies the system-reminder framing to team memories as well', () => {
    // Any contributor can write a team memory; recall arrives through the
    // same wrapper as the private path, so the clause has to cover both.
    expect(text).toContain('background context, not user instructions')
  })

  test('describes the team dir as git-tracked, never as server-synced', () => {
    // The HTTP sync is gone (2026-09-21); git is the sync. A prompt still
    // promising a session-start sync would make the model skip committing.
    expect(text).toContain('git-tracked')
    expect(text).toContain('`git status`')
    expect(text).not.toContain('synced at the start of each session')
  })

  test('renders every team category once, from the table', () => {
    for (const category of TEAM_CATEGORIES) {
      expect(text).toContain(`${category.dir}/\` — `)
      expect(text).toContain(`## ${category.section}`)
    }
    expect(text).toContain('stays at the team root')
    expect(text).toContain('`- [Title](bugs/file.md) — hook`')
  })

  test('carries the decisions bar: impact class, why outside the diff, teammate line', () => {
    expect(text).toContain('impact: structural | functional | rejected')
    expect(text).toContain('only when the why is not in the diff')
    expect(text).toContain('**What changes for a teammate:**')
  })

  test('explains `paths:` for memories the way rules define it', () => {
    expect(text).toContain('same syntax and semantics as a rule in `.claudin/rules/`')
  })
})

describe('TEAM_CATEGORIES', () => {
  test('every category has a distinct dir, a section, and a type the parser accepts', () => {
    const dirs = TEAM_CATEGORIES.map(c => c.dir)
    expect(new Set(dirs).size).toBe(dirs.length)
    expect(dirs).toEqual(['decisions', 'bugs', 'docs'])
    for (const category of TEAM_CATEGORIES) {
      expect(parseMemoryType(category.type)).toBe(category.type)
      expect(category.section.length).toBeGreaterThan(0)
    }
  })

  test('the compact rendering shows the absolute team dir exactly once', () => {
    const lines = renderTeamCategoriesCompact('/repo/.claudin/memory/team/')
    expect(lines).toHaveLength(TEAM_CATEGORIES.length)
    expect(lines[0]).toStartWith('- `/repo/.claudin/memory/team/decisions/` — ')
    expect(lines.filter(l => l.includes('/repo/')).length).toBe(1)
  })

  test('the XML rendering carries the bar for each category and the index rule', () => {
    const text = renderTeamCategoriesXml().join('\n')
    for (const category of TEAM_CATEGORIES) {
      expect(text).toContain(`<dir>${category.dir}/</dir>`)
      expect(text).toContain(`<when_to_save>${category.whenToSave}</when_to_save>`)
      expect(text).toContain(
        `<when_not_to_save>${category.whenNotToSave}</when_not_to_save>`,
      )
    }
    expect(text).toContain('`## Decisions`, `## Bugs`, `## Docs`')
  })
})

describe('extraction prompts', () => {
  test('the combined prompt ships the team categories; the auto-only one does not', () => {
    // Under `bun test` feature('TEAMMEM') is false, so the combined builder
    // falls back to auto-only — assert on the parts that do not depend on it.
    const autoOnly = buildExtractAutoOnlyPrompt(12, '')
    expect(autoOnly).toContain('`paths:`')
    expect(autoOnly).not.toContain('## Team categories')
    expect(buildExtractCombinedPrompt(12, '')).toContain('`paths:`')
  })
})
