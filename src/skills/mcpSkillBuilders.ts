/**
 * The registry through which MCP skill discovery would reach the skill
 * builders without importing the loader, which would close an import cycle.
 * A leaf on purpose: it imports nothing but types.
 *
 * This fork never received MCP skill discovery, so the registry is
 * write-only. When discovery lands, it needs a getter here.
 */
import type { parseSkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
import type { createSkillCommand } from 'src/skills/loading/skillCommand.js'

export type MCPSkillBuilders = {
  /** Frontmatter to fields, the same as for a skill on disk. */
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
  /** MCP skills pass `loadedFrom: 'mcp'`, which keeps their shell from running. */
  createSkillCommand: typeof createSkillCommand
}

let registeredBuilders: MCPSkillBuilders | undefined

export function registerMCPSkillBuilders(builders: MCPSkillBuilders): void {
  registeredBuilders = builders
}
