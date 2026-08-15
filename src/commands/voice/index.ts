import type { Command } from 'src/commands.js'
import {
  isVoiceGrowthBookEnabled,
  isVoiceModeEnabled,
} from 'src/terminal/voice/voiceModeEnabled.js'

const voice = {
  type: 'local',
  name: 'voice',
  description: 'Toggle voice mode',
  availability: ['claude-ai'],
  isEnabled: () => isVoiceGrowthBookEnabled(),
  get isHidden() {
    return !isVoiceModeEnabled()
  },
  supportsNonInteractive: false,
  load: () => import('src/commands/voice/voice.js'),
} satisfies Command

export default voice
