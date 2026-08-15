import type { Command } from 'src/commands.js'
import { isConsumerSubscriber } from 'src/providers/auth/auth.js'

const privacySettings = {
  type: 'local-jsx',
  name: 'privacy-settings',
  description: 'View and update your privacy settings',
  isEnabled: () => {
    return isConsumerSubscriber()
  },
  load: () => import('src/commands/privacy-settings/privacy-settings.js'),
} satisfies Command

export default privacySettings
