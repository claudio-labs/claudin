import {
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_5_CONFIG,
} from 'src/providers/model/configs.js'
import { getAPIProvider } from 'src/providers/model/providers.js'

// @[MODEL LAUNCH]: Update the fallback model below.
// When the user has never set teammateDefaultModel in /config, new teammates
// use Opus 5 on firstParty (4.6 on 3P where 5 may not yet be available).
// Must be provider-aware so Bedrock/Vertex/Foundry customers get the correct
// model ID.
export function getHardcodedTeammateModelFallback(): string {
  const provider = getAPIProvider()
  if (provider === 'firstParty') {
    return CLAUDE_OPUS_5_CONFIG[provider]
  }
  return CLAUDE_OPUS_4_6_CONFIG[provider]
}
