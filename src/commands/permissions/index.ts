import type { Command } from 'src/commands.js'

const permissions = {
  type: 'local-jsx',
  name: 'permissions',
  aliases: ['allowed-tools'],
  description: 'Manage allow & deny tool permission rules',
  load: () => import('src/commands/permissions/permissions.js'),
} satisfies Command

export default permissions
