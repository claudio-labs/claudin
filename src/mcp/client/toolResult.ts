import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/shared/errors.js'
import {
  type MCPToolResult,
  mcpContentNeedsTruncation,
  truncateMcpContent,
} from 'src/mcp/mcpValidation.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { contentItemToBlocks } from 'src/mcp/client/resultContent.js'
import { decideOversize, saveOversizedOutput } from 'src/mcp/client/resultGate.js'

export async function transformResultContent(
  resultContent: PromptMessage['content'],
  serverName: string,
): Promise<Array<ContentBlockParam>> {
  return contentItemToBlocks(resultContent, serverName)
}

export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

export type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
}

const SCHEMA_MAX_KEYS = 10

/** A jq-like shape hint. Arrays spend a level too, so `{items: [{id: 1}]}` reads `{items: [{...}]}`. */
export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value !== 'object') return typeof value
  if (depth <= 0) return '{...}'
  const entries = Object.entries(value)
  const shown = entries
    .slice(0, SCHEMA_MAX_KEYS)
    .map(([key, inner]) => `${key}: ${inferCompactSchema(inner, depth - 1)}`)
  const more = entries.length > SCHEMA_MAX_KEYS ? ', ...' : ''
  return `{${shown.join(', ')}${more}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Each item's own shape is checked per type when it is converted; here only that it has one. */
function isContentItemList(value: unknown): value is PromptMessage['content'][] {
  return Array.isArray(value) && value.every(item => isRecord(item) && typeof item.type === 'string')
}

export async function transformMCPResult(
  result: unknown,
  tool: string,
  name: string,
): Promise<TransformedMCPResult> {
  if (isRecord(result)) {
    if ('toolResult' in result) {
      return { content: String(result.toolResult), type: 'toolResult' }
    }
    if (result.structuredContent !== undefined) {
      const { structuredContent } = result
      return {
        content: jsonStringify(structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(structuredContent),
      }
    }
    if (isContentItemList(result.content)) {
      const perItem = await Promise.all(result.content.map(item => transformResultContent(item, name)))
      const blocks = perItem.flat()
      return { content: blocks, type: 'contentArray', schema: inferCompactSchema(blocks) }
    }
  }
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    `MCP server "${name}" tool "${tool}": unexpected response format`,
    'MCP tool result had an unexpected response format',
  )
}

// Tracked (spec, finding 2): any configured server may take this name.
const IDE_SERVER_NAME = 'ide'

function holdsImage(content: MCPToolResult): boolean {
  return Array.isArray(content) && content.some(block => block.type === 'image')
}

export async function processMCPResult(
  result: unknown,
  tool: string,
  name: string,
): Promise<MCPToolResult> {
  const { content, type, schema } = await transformMCPResult(result, tool, name)
  if (name === IDE_SERVER_NAME) return content
  // Tracked (spec, finding 1): with no count, oversized content passes whole.
  if (content === undefined || !(await mcpContentNeedsTruncation(content))) return content
  const action = decideOversize({
    largeOutputFiles: !isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES),
    hasImage: holdsImage(content),
  })
  if (action === 'cut') return truncateMcpContent(content)
  return saveOversizedOutput({ content, type, schema, server: name, tool })
}
