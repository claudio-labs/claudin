import type { CommandSpec } from 'src/services/bash/registry.js'

const time: CommandSpec = {
  name: 'time',
  description: 'Time a command',
  args: {
    name: 'command',
    description: 'Command to time',
    isCommand: true,
  },
}

export default time
