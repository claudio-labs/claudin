import type { Command } from 'src/commands/commands.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  description: 'Resume a previous conversation',
  aliases: ['continue'],
  argumentHint: '[conversation id or search term]',
  // The session table needs the whole screen: inline sessions visit the alt
  // screen while it is open.
  fullscreenLayout: true,
  load: () => import('src/commands/resume/resume.js'),
}

export default resume
