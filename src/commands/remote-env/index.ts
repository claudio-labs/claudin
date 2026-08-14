import type { Command } from 'src/commands.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import { isClaudeAISubscriber } from 'src/services/auth/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () =>
    isClaudeAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isClaudeAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),
} satisfies Command
