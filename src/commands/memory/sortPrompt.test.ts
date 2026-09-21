import { describe, expect, test } from 'bun:test'
import { TEAM_CATEGORIES } from 'src/memory/memdir/memoryTypes.js'
import { buildMemorySortPrompt } from 'src/commands/memory/sortPrompt.js'

const TEAM = '/repo/.claudin/memory/team/'

describe('buildMemorySortPrompt', () => {
  const prompt = buildMemorySortPrompt(TEAM)

  test('names the team dir without the trailing separator', () => {
    expect(prompt).toContain('/repo/.claudin/memory/team/MEMORY.md')
    expect(prompt).not.toContain('//MEMORY.md')
    expect(prompt).not.toContain('team//')
  })

  test('renders every category with its bar, from the table', () => {
    for (const category of TEAM_CATEGORIES) {
      expect(prompt).toContain(`<dir>${category.dir}/</dir>`)
      expect(prompt).toContain(category.whenToSave)
      expect(prompt).toContain(category.whenNotToSave)
      expect(prompt).toContain(`## ${category.section}`)
    }
  })

  test('moves go through git mv so the permission prompt is the veto', () => {
    expect(prompt).toContain('`git mv /repo/.claudin/memory/team/<file>.md')
    expect(prompt).toContain('`git mv`, not `mv`')
    expect(prompt).toContain('permission prompt for each move')
  })

  test('is scoped to the team root and idempotent', () => {
    expect(prompt).toContain('Only files directly at the team root move')
    expect(prompt).toContain('never a private memory, never between subdirectories')
    expect(prompt).toContain('A second run over a sorted directory moves nothing')
    expect(prompt).toContain('Never create or delete a memory')
  })

  test('asks for the decisions frontmatter and forbids invented paths', () => {
    expect(prompt).toContain('`decisions/`: `scope:` and `impact:`')
    expect(prompt).toContain('Never invent a path')
  })

  test('keeps the index edit surgical', () => {
    expect(prompt).toContain('`(file.md)` → `(<category>/file.md)`')
    expect(prompt).toContain('Everything else stays byte-for-byte')
  })
})
