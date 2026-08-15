/**
 * Clear command - minimal metadata only.
 * Implementation is lazy-loaded from clear.ts to reduce startup time.
 * Utility functions:
 * - clearSessionCaches: import from './clear/caches.js'
 * - clearConversation: import from './clear/conversation.js'
 */
import type { Command } from 'src/commands/commands.js'

const clear = {
  type: 'local',
  name: 'new',
  description: 'Clear conversation history and free up context',
  aliases: ['reset', 'clear'],
  supportsNonInteractive: false, // Should just create a new session
  load: () => import('src/commands/clear/clear.js'),
} satisfies Command

export default clear
