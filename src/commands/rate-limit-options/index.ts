import type { Command } from 'src/commands.js'
import { isClaudeAISubscriber } from 'src/services/auth/auth.js'

const rateLimitOptions = {
  type: 'local-jsx',
  name: 'rate-limit-options',
  description: 'Show options when rate limit is reached',
  isEnabled: () => {
    if (!isClaudeAISubscriber()) {
      return false
    }

    return true
  },
  isHidden: true, // Hidden from help - only used internally
  load: () => import('src/commands/rate-limit-options/rate-limit-options.js'),
} satisfies Command

export default rateLimitOptions
