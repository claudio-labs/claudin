/**
 * Characterization of the memory taxonomy and its renderings
 * (`memoryTypes.ts`), the staleness note (`memoryAge.ts`) and the list of
 * instruction-file kinds (`types.ts`).
 *
 * The prose is pinned by the facts it has to carry — names, keys, formats,
 * the routing of each type — never by its sentences, so a rewrite may say it
 * in its own words.
 */
import { describe, expect, test } from 'bun:test'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  MEMORY_TYPES,
  parseMemoryType,
  renderTeamCategoriesCompact,
  renderTeamCategoriesLean,
  renderTeamCategoriesXml,
  TEAM_CATEGORIES,
  teamCategoryForPath,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from 'src/memory/memdir/memoryTypes.js'
import { memoryFreshnessNote } from 'src/memory/memdir/memoryAge.js'
import { MEMORY_TYPE_VALUES } from 'src/memory/memdir/types.js'

const TEAM_DIR = '/work/app/.claudin/memory/team/'

function categoryNamed(dir: string) {
  const found = TEAM_CATEGORIES.find(category => category.dir === dir)
  if (!found) throw new Error(`no team category ${dir}`)
  return found
}

/** The text between `<tag>` and `</tag>` for each occurrence, in order. */
function tagBodies(text: string, tag: string): string[] {
  const bodies: string[] = []
  let from = 0
  for (;;) {
    const open = text.indexOf(`<${tag}>`, from)
    if (open === -1) return bodies
    const close = text.indexOf(`</${tag}>`, open)
    if (close === -1) throw new Error(`unclosed <${tag}>`)
    bodies.push(text.slice(open + tag.length + 2, close))
    from = close
  }
}

/** The `<type>` block whose `<name>` is `name`, from a types section. */
function typeBlock(section: readonly string[], name: string): string {
  const block = tagBodies(section.join('\n'), 'type').find(body =>
    body.includes(`<name>${name}</name>`),
  )
  if (block === undefined) throw new Error(`no <type> named ${name}`)
  return block
}

describe('the four memory types', () => {
  test('are user, feedback, project and reference, in that order', () => {
    expect([...MEMORY_TYPES]).toEqual(['user', 'feedback', 'project', 'reference'])
  })

  test('parseMemoryType accepts exactly those four strings', () => {
    for (const type of MEMORY_TYPES) expect(parseMemoryType(type)).toBe(type)
    for (const other of ['User', ' user', 'users', 'bug', '', 'decisions']) {
      expect(parseMemoryType(other)).toBeUndefined()
    }
    for (const notText of [undefined, null, 3, true, ['user'], { type: 'user' }]) {
      expect(parseMemoryType(notText)).toBeUndefined()
    }
  })
})

describe('the instruction-file kinds (types.ts)', () => {
  test('are the five kinds of a build without team memory, in order', () => {
    // Under `bun test` every build flag reads false, so the team kind that a
    // shipped build appends at the end is absent here.
    expect([...MEMORY_TYPE_VALUES]).toEqual([
      'User',
      'Project',
      'Local',
      'Managed',
      'AutoMem',
    ])
  })
})

describe('the team categories', () => {
  test('are decisions, bugs and docs, with their index sections, nouns and types', () => {
    expect(
      TEAM_CATEGORIES.map(({ dir, section, noun, type }) => ({ dir, section, noun, type })),
    ).toEqual([
      { dir: 'decisions', section: 'Decisions', noun: 'decision', type: 'project' },
      { dir: 'bugs', section: 'Bugs', noun: 'bug', type: 'project' },
      { dir: 'docs', section: 'Docs', noun: 'doc', type: 'reference' },
    ])
  })

  test('every category carries all of its renderings', () => {
    for (const category of TEAM_CATEGORIES) {
      for (const field of [
        category.compact,
        category.lean,
        category.description,
        category.whenToSave,
        category.whenNotToSave,
        category.bodyStructure,
        category.paths,
      ]) {
        expect(typeof field).toBe('string')
        expect(field.trim().length).toBeGreaterThan(0)
      }
      expect(category.lean.length).toBeLessThan(category.compact.length)
      expect(category.paths).toContain('`paths:`')
    }
  })

  test('decisions: the three impact classes, the frontmatter it adds and the body headings', () => {
    const decisions = categoryNamed('decisions')
    for (const text of [decisions.compact, decisions.lean, decisions.bodyStructure]) {
      expect(text).toContain('`scope:`')
      expect(text).toContain('`impact: structural | functional | rejected`')
      for (const heading of [
        '**Decision:**',
        '**Why:**',
        '**What changes for a teammate:**',
        '**Rejected:**',
        '**Evidence:**',
      ]) {
        expect(text).toContain(heading)
      }
    }
    for (const text of [decisions.compact, decisions.whenToSave]) {
      expect(text).toMatch(/structural/)
      expect(text).toMatch(/functional/)
      expect(text).toMatch(/rejected/)
      expect(text).toMatch(/diff/)
    }
  })

  test('bugs: symptom, place, reproduction and a dated status', () => {
    const bugs = categoryNamed('bugs')
    for (const text of [bugs.compact, bugs.lean]) {
      expect(text).toMatch(/symptom/i)
      expect(text).toMatch(/where/i)
      expect(text).toMatch(/repro/i)
      expect(text).toMatch(/status/i)
      expect(text).toMatch(/date/i)
    }
    for (const heading of ['**Symptom:**', '**Where:**', '**Repro:**', '**Status:**', '**Why not fixed:**']) {
      expect(bugs.bodyStructure).toContain(heading)
    }
  })

  test('docs: a pointer to a subsystem document, typed reference', () => {
    const docs = categoryNamed('docs')
    for (const text of [docs.compact, docs.lean]) {
      expect(text).toContain('`type: reference`')
      expect(text).toMatch(/document/i)
    }
    for (const heading of ['**Doc:**', '**Covers:**', '**Start here when:**', '**Kept in sync by:**']) {
      expect(docs.bodyStructure).toContain(heading)
    }
  })

  test('teamCategoryForPath reads the category off the parent directory name', () => {
    expect(teamCategoryForPath(`${TEAM_DIR}decisions/git-is-the-sync.md`)?.dir).toBe('decisions')
    expect(teamCategoryForPath(`${TEAM_DIR}bugs/flaky-lock.md`)?.dir).toBe('bugs')
    expect(teamCategoryForPath(`${TEAM_DIR}docs/provider-docs.md`)?.dir).toBe('docs')
    expect(teamCategoryForPath('bugs/relative.md')?.noun).toBe('bug')
    // Pure: any parent named like a category matches, team dir or not.
    expect(teamCategoryForPath('/work/app/.claudin/memory/bugs/private.md')?.dir).toBe('bugs')
  })

  test('teamCategoryForPath is undefined at the team root, deeper down, and for the directory itself', () => {
    expect(teamCategoryForPath(`${TEAM_DIR}conventions.md`)).toBeUndefined()
    expect(teamCategoryForPath(`${TEAM_DIR}bugs/archive/old.md`)).toBeUndefined()
    expect(teamCategoryForPath(`${TEAM_DIR}bugs`)).toBeUndefined()
    expect(teamCategoryForPath(`${TEAM_DIR}bugs/`)).toBeUndefined()
  })
})

describe('the category renderings', () => {
  const [decisions, bugs, docs] = [categoryNamed('decisions'), categoryNamed('bugs'), categoryNamed('docs')]

  test('compact: one bullet per category, the absolute team dir on the first only', () => {
    const lines = renderTeamCategoriesCompact(TEAM_DIR)
    expect(lines).toEqual([
      `- \`${TEAM_DIR}decisions/\` — ${decisions.compact}`,
      `- \`bugs/\` — ${bugs.compact}`,
      `- \`docs/\` — ${docs.compact}`,
    ])
  })

  test('lean: the same bullets with the shorter bar', () => {
    const lines = renderTeamCategoriesLean(TEAM_DIR)
    expect(lines).toEqual([
      `- \`${TEAM_DIR}decisions/\` — ${decisions.lean}`,
      `- \`bugs/\` — ${bugs.lean}`,
      `- \`docs/\` — ${docs.lean}`,
    ])
  })

  test('the tagged section: a heading, one <category> per entry with every field, then the index rule', () => {
    const lines = renderTeamCategoriesXml()
    expect(lines[0]).toBe('## Team categories')
    expect(lines.at(-1)).toBe('')
    const text = lines.join('\n')
    expect(text).toMatch(/team root/)

    const blocks = tagBodies(text, 'category')
    expect(blocks).toHaveLength(TEAM_CATEGORIES.length)
    TEAM_CATEGORIES.forEach((category, i) => {
      const block = blocks[i]!
      const fields: Array<[string, string]> = [
        ['dir', `${category.dir}/`],
        ['type', category.type],
        ['description', category.description],
        ['when_to_save', category.whenToSave],
        ['when_not_to_save', category.whenNotToSave],
        ['body_structure', category.bodyStructure],
        ['paths', category.paths],
      ]
      let previous = -1
      for (const [tag, value] of fields) {
        const at = block.indexOf(`<${tag}>${value}</${tag}>`)
        expect(at).toBeGreaterThan(previous)
        previous = at
      }
    })
    expect(text.indexOf('<categories>')).toBeLessThan(text.indexOf('<category>'))
    expect(text.lastIndexOf('</category>')).toBeLessThan(text.indexOf('</categories>'))

    const rule = text.slice(text.indexOf('</categories>'))
    for (const section of ['`## Decisions`', '`## Bugs`', '`## Docs`']) {
      expect(rule).toContain(section)
    }
    expect(rule).toContain('MEMORY.md')
    expect(rule).toContain('](bugs/file.md)')
  })
})

describe('the types sections the extraction prompts embed', () => {
  test('both open with the same heading, list the four types in order, and end on a blank line', () => {
    for (const section of [TYPES_SECTION_COMBINED, TYPES_SECTION_INDIVIDUAL]) {
      expect(section[0]).toBe('## Types of memory')
      expect(section.at(-1)).toBe('')
      const names = tagBodies(section.join('\n'), 'name')
      expect(names).toEqual(['user', 'feedback', 'project', 'reference'])
      for (const type of MEMORY_TYPES) {
        const block = typeBlock(section, type)
        for (const tag of ['description', 'when_to_save', 'how_to_use', 'examples']) {
          expect(block).toContain(`<${tag}>`)
          expect(block).toContain(`</${tag}>`)
        }
      }
    }
  })

  test('feedback and project bodies lead with the rule or fact, then Why and How to apply', () => {
    for (const section of [TYPES_SECTION_COMBINED, TYPES_SECTION_INDIVIDUAL]) {
      for (const type of ['feedback', 'project']) {
        const [structure] = tagBodies(typeBlock(section, type), 'body_structure')
        expect(structure).toContain('**Why:**')
        expect(structure).toContain('**How to apply:**')
      }
      for (const type of ['user', 'reference']) {
        expect(typeBlock(section, type)).not.toContain('<body_structure>')
      }
    }
  })

  test('the facts each type block states', () => {
    for (const section of [TYPES_SECTION_COMBINED, TYPES_SECTION_INDIVIDUAL]) {
      expect(typeBlock(section, 'feedback')).toMatch(/confirm/i)
      expect(typeBlock(section, 'project')).toMatch(/absolute date/)
      expect(typeBlock(section, 'reference')).toMatch(/external/)
    }
  })

  test('only the combined section says where each type goes', () => {
    const scopes = tagBodies(TYPES_SECTION_COMBINED.join('\n'), 'scope')
    expect(scopes).toHaveLength(4)
    const [user, feedback, project, reference] = scopes as [string, string, string, string]
    expect(user).toMatch(/always private/)
    expect(feedback).toMatch(/private/)
    expect(feedback).toMatch(/team/)
    expect(feedback).toMatch(/team root/)
    expect(project).toMatch(/team/)
    expect(project).toContain('`decisions/`')
    expect(project).toContain('`bugs/`')
    expect(reference).toMatch(/team/)
    expect(reference).toContain('`docs/`')

    expect(TYPES_SECTION_INDIVIDUAL.join('\n')).not.toContain('<scope>')
  })

  test('the examples name the chosen scope only in the combined section', () => {
    const combined = TYPES_SECTION_COMBINED.join('\n')
    const individual = TYPES_SECTION_INDIVIDUAL.join('\n')
    expect(combined).toMatch(/\[saves private \w+ memory:/)
    expect(combined).toMatch(/\[saves team \w+ memory:/)
    expect(individual).toMatch(/\[saves \w+ memory:/)
    expect(individual).not.toMatch(/\[saves (private|team) /)
  })
})

describe('what not to save', () => {
  test('a heading, then the exclusions, and the rule that they hold even on request', () => {
    expect(WHAT_NOT_TO_SAVE_SECTION[0]).toMatch(/^## .*not to save/i)
    const text = WHAT_NOT_TO_SAVE_SECTION.join('\n')
    expect(WHAT_NOT_TO_SAVE_SECTION.some(line => line.startsWith('- '))).toBe(true)
    expect(text).toMatch(/code pattern/i)
    expect(text).toMatch(/architecture/i)
    expect(text).toContain('`git log`')
    expect(text).toContain('`git blame`')
    expect(text).toMatch(/debugging/i)
    expect(text).toContain('CLAUDE.md')
    expect(text).toMatch(/in-progress|ephemeral/i)
    expect(text).toMatch(/routine/i)
    const last = WHAT_NOT_TO_SAVE_SECTION.at(-1)!
    expect(last.startsWith('- ')).toBe(false)
    expect(last).toMatch(/explicit/i)
    expect(last).toMatch(/surprising|non-obvious/)
  })
})

describe('the frontmatter example', () => {
  test('is a fenced markdown block with name, description and a top-level type', () => {
    const lines = [...MEMORY_FRONTMATTER_EXAMPLE]
    expect(lines[0]).toBe('```markdown')
    expect(lines.at(-1)).toBe('```')
    const open = lines.indexOf('---')
    const close = lines.indexOf('---', open + 1)
    expect(open).toBe(1)
    const keys = lines.slice(open + 1, close).map(line => line.split(':')[0])
    expect(keys).toEqual(['name', 'description', 'type'])
    expect(lines).toContain('type: {{user | feedback | project | reference}}')
    expect(lines.some(line => /^\s+\S/.test(line))).toBe(false)
    expect(lines.join('\n')).not.toContain('metadata')
  })

  test('its placeholders say what goes where', () => {
    const lines = [...MEMORY_FRONTMATTER_EXAMPLE]
    expect(lines.find(line => line.startsWith('name:'))).toMatch(/kebab/)
    expect(lines.find(line => line.startsWith('description:'))).toMatch(/relevan/)
    const body = lines.slice(lines.lastIndexOf('---') + 1, -1).join('\n')
    expect(body).toContain('**Why:**')
    expect(body).toContain('**How to apply:**')
    expect(body).toContain('[[')
  })
})

describe('memory age', () => {
  const DAY = 86_400_000
  const SLACK = 60_000

  test('no note for a memory from today or yesterday', () => {
    expect(memoryFreshnessNote(Date.now())).toBe('')
    expect(memoryFreshnessNote(Date.now() - DAY + SLACK)).toBe('')
    expect(memoryFreshnessNote(Date.now() - DAY - SLACK)).toBe('')
    expect(memoryFreshnessNote(Date.now() - 2 * DAY + SLACK)).toBe('')
    expect(memoryFreshnessNote(Date.now() + 5 * DAY)).toBe('')
  })

  test('from two days on: one reminder block, ending in a newline, naming the age', () => {
    for (const days of [2, 45, 400]) {
      const note = memoryFreshnessNote(Date.now() - days * DAY - SLACK)
      expect(note.startsWith('<system-reminder>')).toBe(true)
      expect(note.endsWith('</system-reminder>\n')).toBe(true)
      expect(note.split('<system-reminder>')).toHaveLength(2)
      expect(note).toContain(`${days} days`)
      expect(note).toContain('file:line')
      expect(note).toMatch(/verify/i)
    }
  })

  test('the age is whole days, rounded down', () => {
    const note = memoryFreshnessNote(Date.now() - 3 * DAY + SLACK)
    expect(note).toContain('2 days')
    expect(note).not.toContain('3 days')
  })
})
