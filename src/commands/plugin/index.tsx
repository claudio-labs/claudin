import type { Command } from 'src/commands/commands.js';
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claude Code plugins',
  immediate: true,
  load: () => import('src/commands/plugin/plugin.js')
} satisfies Command;
export default plugin;
