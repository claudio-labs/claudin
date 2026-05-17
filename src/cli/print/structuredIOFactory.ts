import { StructuredIO } from 'src/cli/structuredIO.js'
import { RemoteIO } from 'src/cli/remoteIO.js'
import type { SDKUserMessage } from 'src/entrypoints/agentSdkTypes.js'
import { fromArray } from 'src/utils/generators.js'
import { jsonStringify } from 'src/utils/slowOperations.js'

/**
 * Build the StructuredIO (or RemoteIO when `sdkUrl` is set) that owns the
 * headless input stream. String prompts are wrapped in a synthetic
 * SDKUserMessage envelope; AsyncIterable prompts pass through.
 */
export function getStructuredIO(
  inputPrompt: string | AsyncIterable<string>,
  options: {
    sdkUrl: string | undefined
    replayUserMessages?: boolean
  },
): StructuredIO {
  let inputStream: AsyncIterable<string>
  if (typeof inputPrompt === 'string') {
    if (inputPrompt.trim() !== '') {
      // Normalize to a streaming input.
      inputStream = fromArray([
        jsonStringify({
          type: 'user',
          session_id: '',
          message: {
            role: 'user',
            content: inputPrompt,
          },
          parent_tool_use_id: null,
        } satisfies SDKUserMessage),
      ])
    } else {
      // Empty string - create empty stream
      inputStream = fromArray([])
    }
  } else {
    inputStream = inputPrompt
  }

  // Use RemoteIO if sdkUrl is provided, otherwise use regular StructuredIO
  return options.sdkUrl
    ? new RemoteIO(options.sdkUrl, inputStream, options.replayUserMessages)
    : new StructuredIO(inputStream, options.replayUserMessages)
}
