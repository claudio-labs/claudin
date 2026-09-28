/**
 * The memory taxonomy: the four types of a memory file, the three team
 * categories, and the prompt fragments other prompts embed.
 */
export {
  MEMORY_TYPES,
  type MemoryType,
  parseMemoryType,
} from 'src/memory/memdir/taxonomy/memoryKinds.js'
export {
  TEAM_CATEGORIES,
  type TeamCategory,
  teamCategoryForPath,
} from 'src/memory/memdir/taxonomy/teamCategories.js'
export {
  renderTeamCategoriesCompact,
  renderTeamCategoriesLean,
  renderTeamCategoriesXml,
} from 'src/memory/memdir/taxonomy/categoryRenderings.js'
export {
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
} from 'src/memory/memdir/taxonomy/typeSections.js'
export { WHAT_NOT_TO_SAVE_SECTION } from 'src/memory/memdir/taxonomy/whatNotToSave.js'
export { MEMORY_FRONTMATTER_EXAMPLE } from 'src/memory/memdir/taxonomy/frontmatterExample.js'
