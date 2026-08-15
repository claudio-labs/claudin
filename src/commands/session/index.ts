import { getIsRemoteMode } from 'src/platform/bootstrap/state.js'
import type { Command } from 'src/commands.js'

const session = {
  type: 'local-jsx',
  name: 'session',
  aliases: ['remote'],
  description: 'Show remote session URL and QR code',
  isEnabled: () => getIsRemoteMode(),
  get isHidden() {
    return !getIsRemoteMode()
  },
  load: () => import('src/commands/session/session.js'),
} satisfies Command

export default session
