/**
 * Utility functions for detecting code indexing tool usage.
 *
 * Tracks usage of common code indexing solutions like Sourcegraph, Cody, etc.
 * both via CLI commands and MCP server integrations.
 */

/**
 * Known code indexing tool identifiers.
 * These are the normalized names used in analytics events.
 */
export type CodeIndexingTool =
  // Code search engines
  | 'sourcegraph'
  | 'hound'
  | 'seagoat'
  | 'bloop'
  | 'gitloop'
  // AI coding assistants with indexing
  | 'cody'
  | 'aider'
  | 'continue'
  | 'github-copilot'
  | 'cursor'
  | 'tabby'
  | 'codeium'
  | 'tabnine'
  | 'augment'
  | 'windsurf'
  | 'aide'
  | 'pieces'
  | 'qodo'
  | 'amazon-q'
  | 'gemini'
  // MCP code indexing servers
  | 'claude-context'
  | 'code-index-mcp'
  | 'local-code-search'
  | 'autodev-codebase'
  // Context providers
  | 'openctx'

/**
 * Mapping of CLI command prefixes to code indexing tools.
 * The key is the command name (first word of the command).
 */
const CLI_COMMAND_MAPPING: Record<string, CodeIndexingTool> = {
  // Sourcegraph ecosystem
  src: 'sourcegraph',
  cody: 'cody',
  // AI coding assistants
  aider: 'aider',
  tabby: 'tabby',
  tabnine: 'tabnine',
  augment: 'augment',
  pieces: 'pieces',
  qodo: 'qodo',
  aide: 'aide',
  // Code search tools
  hound: 'hound',
  seagoat: 'seagoat',
  bloop: 'bloop',
  gitloop: 'gitloop',
  // Cloud provider AI assistants
  q: 'amazon-q',
  gemini: 'gemini',
}

/**
 * Detects if a bash command is using a code indexing CLI tool.
 *
 * @param command - The full bash command string
 * @returns The code indexing tool identifier, or undefined if not a code indexing command
 *
 * @example
 * detectCodeIndexingFromCommand('src search "pattern"') // returns 'sourcegraph'
 * detectCodeIndexingFromCommand('cody chat --message "help"') // returns 'cody'
 * detectCodeIndexingFromCommand('ls -la') // returns undefined
 */
export function detectCodeIndexingFromCommand(
  command: string,
): CodeIndexingTool | undefined {
  // Extract the first word (command name)
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase()

  if (!firstWord) {
    return undefined
  }

  // Check for npx/bunx prefixed commands
  if (firstWord === 'npx' || firstWord === 'bunx') {
    const secondWord = trimmed.split(/\s+/)[1]?.toLowerCase()
    if (secondWord && secondWord in CLI_COMMAND_MAPPING) {
      return CLI_COMMAND_MAPPING[secondWord]
    }
  }

  return CLI_COMMAND_MAPPING[firstWord]
}
