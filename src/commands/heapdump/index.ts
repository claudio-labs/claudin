import type { Command } from 'src/commands/commands.js'

const heapDump = {
  type: 'local',
  name: 'heapdump',
  description: 'Dump the JS heap to ~/Desktop',
  isHidden: true,
  supportsNonInteractive: true,
  load: () => import('src/commands/heapdump/heapdump.js'),
} satisfies Command

export default heapDump
