import type { Command } from 'src/commands.js'
import { isKeybindingCustomizationEnabled } from 'src/terminal/keybindings/loadUserBindings.js'

const keybindings = {
  name: 'keybindings',
  description: 'Open or create your keybindings configuration file',
  isEnabled: () => isKeybindingCustomizationEnabled(),
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('src/commands/keybindings/keybindings.js'),
} satisfies Command

export default keybindings
