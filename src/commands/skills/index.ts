import type { Command } from 'src/commands/commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available skills',
  load: () => import('src/commands/skills/skills.js'),
} satisfies Command

export default skills
