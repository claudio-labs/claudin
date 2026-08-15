import type { Command } from 'src/commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  immediate: true,
  argumentHint: '[enable|disable [server-name]]',
  load: () => import('src/commands/mcp/mcp.js'),
} satisfies Command

export default mcp
