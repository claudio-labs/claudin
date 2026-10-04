import type {
  ContentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import {
  countMessagesTokensWithAPI,
  roughTokenCountEstimation,
} from 'src/shared/tokenEstimation.js'
import { compressImageBlock } from 'src/terminal/image/imageResizer.js'
import { logError } from 'src/shared/log.js'
import { truncationNotice } from 'src/mcp/client/modelTexts.js'

export const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5
export const IMAGE_TOKEN_ESTIMATE = 1600

const FALLBACK_OUTPUT_TOKEN_CAP = 25_000
const CHARS_PER_TOKEN_WHEN_CUTTING = 4
// Image data is base64: four characters carry three bytes.
const BYTES_PER_BASE64_CHAR = 3 / 4

export function getMaxMcpOutputTokens(): number {
  const configured = Number.parseInt(process.env.MAX_MCP_OUTPUT_TOKENS ?? '', 10)
  return configured > 0 ? configured : FALLBACK_OUTPUT_TOKEN_CAP
}

export type MCPToolResult = string | ContentBlockParam[] | undefined

function isTextBlock(block: ContentBlockParam): block is TextBlockParam {
  return block.type === 'text'
}

function isImageBlock(block: ContentBlockParam): block is ImageBlockParam {
  return block.type === 'image'
}

function blockTokenEstimate(block: ContentBlockParam): number {
  if (isTextBlock(block)) return roughTokenCountEstimation(block.text)
  if (isImageBlock(block)) return IMAGE_TOKEN_ESTIMATE
  return 0
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  if (content === undefined) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  return content.reduce((sum, block) => sum + blockTokenEstimate(block), 0)
}

/** True only when the model's counter puts the content over the cap; no count means it passes. */
export async function mcpContentNeedsTruncation(
  content: MCPToolResult,
): Promise<boolean> {
  if (!content) return false
  const cap = getMaxMcpOutputTokens()
  if (getContentSizeEstimate(content) <= cap * MCP_TOKEN_COUNT_THRESHOLD_FACTOR) return false
  try {
    const counted = await countMessagesTokensWithAPI([{ role: 'user', content }], [])
    return counted !== null && counted > cap
  } catch (error) {
    logError(error)
    return false
  }
}

/** Fits images into `budgetChars` of base64, or drops them (undefined) when that fails. */
async function fitImage(block: ImageBlockParam, budgetChars: number): Promise<ImageBlockParam | undefined> {
  if (budgetChars <= 0) return undefined
  try {
    return await compressImageBlock(block, Math.floor(budgetChars * BYTES_PER_BASE64_CHAR))
  } catch (error) {
    logError(error)
    return undefined
  }
}

async function cutBlocks(blocks: ContentBlockParam[], budgetChars: number, notice: string): Promise<ContentBlockParam[]> {
  const kept: ContentBlockParam[] = []
  let left = budgetChars
  for (const block of blocks) {
    if (isTextBlock(block)) {
      if (left <= 0) continue
      const text = block.text.slice(0, left)
      kept.push(text === block.text ? block : { ...block, text })
      left -= text.length
    } else if (isImageBlock(block)) {
      const cost = IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN_WHEN_CUTTING
      if (cost <= left) {
        kept.push(block)
        left -= cost
        continue
      }
      const squeezed = await fitImage(block, left)
      if (squeezed) {
        kept.push(squeezed)
        left = 0
      }
    } else {
      kept.push(block)
    }
  }
  kept.push({ type: 'text', text: notice })
  return kept
}

export async function truncateMcpContent(
  content: MCPToolResult,
): Promise<MCPToolResult> {
  if (content === undefined) return undefined
  const cap = getMaxMcpOutputTokens()
  const budgetChars = cap * CHARS_PER_TOKEN_WHEN_CUTTING
  const notice = truncationNotice(cap)
  if (typeof content === 'string') return `${content.slice(0, budgetChars)}\n\n${notice}`
  return cutBlocks(content, budgetChars, notice)
}

export async function truncateMcpContentIfNeeded(
  content: MCPToolResult,
): Promise<MCPToolResult> {
  return (await mcpContentNeedsTruncation(content)) ? truncateMcpContent(content) : content
}
