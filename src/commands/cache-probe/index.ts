import type { Command } from '../../commands.js'
import { tryGetActiveProvider } from '../../services/api/activeProvider.js'

const cacheProbe: Command = {
  type: 'local',
  name: 'cache-probe',
  description:
    'Send identical requests to test prompt caching (results in debug log)',
  argumentHint: '[model] [--no-key]',
  isEnabled: () => {
    const transport = tryGetActiveProvider()?.transport
    return (
      transport === 'openai_compat' ||
      transport === 'codex_responses' ||
      transport === 'github_copilot'
    )
  },
  supportsNonInteractive: false,
  load: () => import('./cache-probe.js'),
}

export default cacheProbe
