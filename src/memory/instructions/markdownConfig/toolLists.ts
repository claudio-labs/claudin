/**
 * The tool lists of `tools:`, `allowed-tools:` and `skills:` frontmatter. Both
 * readers split a value the way the command line's tool flags are split; they
 * differ only in what an absent key and the wildcard mean.
 */
import { parseToolListFromCLI } from 'src/permissions/permissionSetup/cliToolParsing.js'

const WILDCARD = '*'

export function parseSlashCommandToolsFromFrontmatter(toolsValue: unknown): string[] {
  return namedTools(toolsValue) ?? [WILDCARD]
}

/** `undefined` grants every tool: the key is absent, or the wildcard is listed. */
export function parseAgentToolsFromFrontmatter(toolsValue: unknown): string[] | undefined {
  return toolsValue === undefined ? undefined : namedTools(toolsValue)
}

/** The tools a value names, or `undefined` when one of them is the bare wildcard. */
function namedTools(value: unknown): string[] | undefined {
  const tools = parseToolListFromCLI(entriesOf(value))
  return tools.includes(WILDCARD) ? undefined : tools
}

/** A string is one entry and a list keeps its strings; nothing else names a tool. */
function entriesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return []
}
