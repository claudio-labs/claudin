import { ENTRYPOINT_NAME } from 'src/memory/memdir/entrypoint/limits.js'
import {
  TEAM_CATEGORIES,
  type TeamCategory,
} from 'src/memory/memdir/taxonomy/teamCategories.js'

/** One bullet per category for the full system prompt. */
export function renderTeamCategoriesCompact(teamDir: string): string[] {
  return renderBullets(teamDir, category => category.compact)
}

/** The same bullets with the shorter text of the lean system prompt. */
export function renderTeamCategoriesLean(teamDir: string): string[] {
  return renderBullets(teamDir, category => category.lean)
}

// Only the first bullet carries the absolute team directory: once is enough
// to anchor the relative names that follow.
function renderBullets(
  teamDir: string,
  text: (category: TeamCategory) => string,
): string[] {
  return TEAM_CATEGORIES.map((category, index) => {
    const location =
      index === 0 ? `${teamDir}${category.dir}/` : `${category.dir}/`
    return `- \`${location}\` — ${text(category)}`
  })
}

/** The verbose, tagged section for the extraction, dream and sort prompts. */
export function renderTeamCategoriesXml(): string[] {
  const headings = TEAM_CATEGORIES.map(
    category => `\`## ${category.section}\``,
  ).join(', ')
  return [
    '## Team categories',
    '',
    'The team directory is organized around what a teammate will come looking for. Three subdirectories hold the product-facing memory; team-scoped notes of any other kind stay at the team root.',
    '',
    '<categories>',
    ...TEAM_CATEGORIES.flatMap(renderCategoryBlock),
    '</categories>',
    '',
    `A categorized memory gets its pointer line in the team \`${ENTRYPOINT_NAME}\`, under the heading of its category (${headings}); add the heading when it is missing. The link includes the category directory, as in \`- [Title](bugs/file.md) — hook\`.`,
    '',
  ]
}

function renderCategoryBlock(category: TeamCategory): string[] {
  return [
    '<category>',
    field('dir', `${category.dir}/`),
    field('type', category.type),
    field('description', category.description),
    field('when_to_save', category.whenToSave),
    field('when_not_to_save', category.whenNotToSave),
    field('body_structure', category.bodyStructure),
    field('paths', category.paths),
    '</category>',
  ]
}

function field(tag: string, text: string): string {
  return `  <${tag}>${text}</${tag}>`
}
