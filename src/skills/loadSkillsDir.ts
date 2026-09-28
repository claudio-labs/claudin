/**
 * The skills and slash commands that users and projects keep on disk as
 * markdown, and the session's dynamic skills. This module is the public
 * contract; the loader lives in src/skills/loading/:
 *
 * - frontmatterFields, skillCommand, skillPrompt: a markdown file to a Command
 * - skillsDirectory, legacyCommands: reading skills and legacy commands
 * - skillListing, sourceGates: what is listed for a cwd, and the switches
 * - sessionSkills, pathScope: held, activated and discovered skills
 * - skillDirDiscovery: skills directories found under a touched file
 */
import { parseSkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
import { createSkillCommand } from 'src/skills/loading/skillCommand.js'
import { registerMCPSkillBuilders } from 'src/skills/mcpSkillBuilders.js'

export { parseSkillFrontmatterFields } from 'src/skills/loading/frontmatterFields.js'
export {
  createSkillCommand,
  estimateSkillFrontmatterTokens,
  type LoadedFrom,
} from 'src/skills/loading/skillCommand.js'
export {
  clearSkillCaches,
  getSkillDirCommands,
  getSkillsPath,
} from 'src/skills/loading/skillListing.js'
export {
  activateConditionalSkillsForPaths,
  clearDynamicSkills,
  getDynamicSkills,
  onDynamicSkillsLoaded,
} from 'src/skills/loading/sessionSkills.js'
export {
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from 'src/skills/loading/skillDirDiscovery.js'

registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })
