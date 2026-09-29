import type { Command } from 'src/commands/commands.js';
const plugin = {
  type: 'local-jsx',
  name: 'plugin',
  aliases: ['plugins', 'marketplace'],
  description: 'Manage Claudin plugins',
  argumentHint: '[install|manage|uninstall|enable|disable|validate|marketplace]',
  immediate: true,
  load: () => import('src/commands/plugin/plugin.js')
} satisfies Command;
export default plugin;
