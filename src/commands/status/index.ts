import type { Command } from 'src/commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
  immediate: true,
  load: () => import('src/commands/status/status.js'),
} satisfies Command

export default status
