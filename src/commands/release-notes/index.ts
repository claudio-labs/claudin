import type { Command } from 'src/commands.js'

const releaseNotes: Command = {
  description: 'View release notes',
  name: 'release-notes',
  type: 'local',
  supportsNonInteractive: true,
  load: () => import('src/commands/release-notes/release-notes.js'),
}

export default releaseNotes
