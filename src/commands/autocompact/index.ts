import type { Command } from 'src/commands/commands.js'
import { getIsNonInteractiveSession } from 'src/platform/bootstrap/state.js'

const DESCRIPTION = 'Set how full the context gets before auto-summarizing'
const ARGUMENT_HINT = '[auto|<tokens>]'

export const autocompact: Command = {
  type: 'local-jsx',
  name: 'autocompact',
  description: DESCRIPTION,
  argumentHint: ARGUMENT_HINT,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('src/commands/autocompact/autocompact.js'),
}

export const autocompactNonInteractive: Command = {
  type: 'local',
  name: 'autocompact',
  supportsNonInteractive: true,
  description: DESCRIPTION,
  argumentHint: ARGUMENT_HINT,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import('src/commands/autocompact/autocompact-noninteractive.js'),
}
