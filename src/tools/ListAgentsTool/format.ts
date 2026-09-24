/** One agent this conversation can message, as ListAgents prints it. */
export type AgentRow = {
  /** The address: what goes in SendMessage's `to`. */
  name: string
  /** Status and description, printed after the name. */
  details: string[]
}

export type AgentListing = {
  subagents: AgentRow[]
  teammates: AgentRow[]
}

export const SECTION_ROW_CAP = 100
const FIELD_SEPARATOR = '  ·  '

function formatSection(title: string, rows: AgentRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const shown = rows.slice(0, SECTION_ROW_CAP).map(row =>
    `  ${[row.name, ...row.details.filter(Boolean)].join(FIELD_SEPARATOR)}`,
  )
  if (rows.length > SECTION_ROW_CAP) {
    shown.push(`  (… ${rows.length - SECTION_ROW_CAP} more not shown)`)
  }
  return `${title} (${rows.length}):\n${shown.join('\n')}`
}

/** The model-facing text of a ListAgents result. */
export function formatAgentListing(listing: AgentListing): string {
  const sections = [
    formatSection('Subagents', listing.subagents),
    formatSection('Teammates', listing.teammates),
  ].filter((section): section is string => section !== undefined)
  if (sections.length === 0) {
    return 'No agents to message yet. A background agent you spawn with Agent (run_in_background) shows up here, under the name you give it.'
  }
  return sections.join('\n\n')
}
