// What happens to a tool result the counter put over the cap: saved to a file
// the model is told to read, or cut with a notice.
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { saveFailedText } from 'src/mcp/client/modelTexts.js'
import { toolResultFile } from 'src/mcp/client/resultFiles.js'
import {
  getFormatDescription,
  getLargeOutputInstructions,
} from 'src/mcp/mcpOutputStorage.js'
import type { MCPResultType } from 'src/mcp/client/toolResult.js'
import { isPersistError, persistToolResult } from 'src/agent/tools/toolResultStorage.js'
import { jsonStringify } from 'src/platform/slowOperations.js'

export type OversizeAction = 'save' | 'cut'

export type OversizeFlags = {
  /** `ENABLE_MCP_LARGE_OUTPUT_FILES` is not set to a false value. */
  largeOutputFiles: boolean
  hasImage: boolean
}

/** Images cannot go into a text file, so content holding one is always cut. */
export function decideOversize({ largeOutputFiles, hasImage }: OversizeFlags): OversizeAction {
  return largeOutputFiles && !hasImage ? 'save' : 'cut'
}

export type OversizedOutput = {
  content: string | ContentBlockParam[]
  type: MCPResultType
  schema?: string
  server: string
  tool: string
}

/** Writes the output as text and answers with the read-the-file instructions, or with why it could not. */
export async function saveOversizedOutput({ content, type, schema, server, tool }: OversizedOutput): Promise<string> {
  const text = typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const saved = await persistToolResult(text, toolResultFile({ kind: 'output', server, tool }))
  if (isPersistError(saved)) return saveFailedText(text.length, saved.error)
  return getLargeOutputInstructions(saved.filepath, saved.originalSize, getFormatDescription(type, schema))
}
