import { describe, expect, test } from 'bun:test'
import {
  TEAM_CATEGORIES,
  type TeamCategory,
  teamCategoryForPath,
} from 'src/memory/memdir/memoryTypes.js'

describe('teamCategoryForPath', () => {
  // The transcript's count line ranks a category by its position in the
  // table, so the lookup has to hand back the table's own entry.
  test('returns the entry of the table itself, not a copy', () => {
    const lookup = (dir: TeamCategory['dir']) =>
      teamCategoryForPath(`/repo/.claudin/memory/team/${dir}/note.md`)
    TEAM_CATEGORIES.forEach((category, index) => {
      const found = lookup(category.dir)
      expect(found).toBe(category)
      expect(found && TEAM_CATEGORIES.indexOf(found)).toBe(index)
    })
  })
})
