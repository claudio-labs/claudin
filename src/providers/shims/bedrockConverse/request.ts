/**
 * Anthropic Messages params → a Bedrock ConverseStream input, laid out as the
 * recorded requests show (src/providers/__fixtures__/cassettes/bedrock-converse/):
 *
 * - `system` is a list of text blocks; `cache_control` has no Converse form
 *   for these models and is dropped.
 * - text, images and PDFs keep their place; a tool_use is a `toolUse`, a
 *   tool_result a `toolResult` with `status`.
 * - Thinking blocks are not sent back: this wire asks for no reasoning, and a
 *   model that reasoned anyway rejects a reasoning block it cannot verify.
 * - Tools are `toolSpec`s; `tool_choice` none sends no choice. Converse
 *   refuses tool blocks in a request without `toolConfig`, so with no tools
 *   they go as text.
 * - Every Anthropic-only field (thinking, betas, metadata, output_config, …)
 *   stays behind.
 */
import {
  applyStableInputStubs,
  applyStableStubs,
} from 'src/agent/compact/stableStubState.js'

/** An Anthropic content block, read field by field. */
type Block = {
  type?: string
  text?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  is_error?: unknown
  content?: unknown
  source?: { type?: string; media_type?: string; data?: unknown }
}
type ConverseBlock = Record<string, unknown>
type ConverseMessage = { role: 'user' | 'assistant'; content: ConverseBlock[] }

const IMAGE_FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? (content as Block[]) : []
}

function bytesOf(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'))
}

function imageBlock(block: Block): ConverseBlock | undefined {
  const source = block.source
  const format = source?.type === 'base64' ? IMAGE_FORMATS[String(source.media_type)] : undefined
  return format ? { image: { format, source: { bytes: bytesOf(String(source!.data)) } } } : undefined
}

/** Document names must be unique in a request and plain: letters, digits, spaces, dashes. */
function documentBlock(block: Block, ordinal: number): ConverseBlock | undefined {
  const source = block.source
  if (source?.type === 'base64' && source.media_type === 'application/pdf') {
    return { document: { format: 'pdf', name: `document-${ordinal}`, source: { bytes: bytesOf(String(source.data)) } } }
  }
  if (source?.type === 'text' && typeof source.data === 'string') return { text: source.data }
  return undefined
}

function toolResultContent(block: Block, documents: { n: number }): ConverseBlock[] {
  const parts: ConverseBlock[] = []
  for (const part of blocksOf(block.content)) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text) parts.push({ text: part.text })
    else if (part.type === 'image') {
      const image = imageBlock(part)
      if (image) parts.push(image)
    } else if (part.type === 'document') {
      const document = documentBlock(part, ++documents.n)
      if (document) parts.push(document)
    }
  }
  // An empty result is valid for Anthropic; Converse wants something in it.
  return parts.length > 0 ? parts : [{ text: block.is_error ? 'Error' : '(no output)' }]
}

function toolUseAsText(block: Block): string {
  return `[Called ${String(block.name)} with ${JSON.stringify(block.input ?? {})}]`
}

function toolResultAsText(block: Block): string {
  const text = blocksOf(block.content)
    .filter(part => part.type === 'text')
    .map(part => String(part.text))
    .join('\n')
  return `[Result of ${String(block.tool_use_id)}${block.is_error ? ' (error)' : ''}]\n${text}`
}

function convertMessages(
  messages: Array<{ role?: string; message?: { role?: string; content?: unknown }; content?: unknown }>,
  options: { toolBlocks: boolean },
): ConverseMessage[] {
  const out: ConverseMessage[] = []
  const documents = { n: 0 }
  for (const message of messages) {
    const inner = message.message ?? message
    const role = (inner as { role?: string }).role ?? message.role
    if (role !== 'user' && role !== 'assistant') continue
    const content: ConverseBlock[] = []
    for (const block of blocksOf((inner as { content?: unknown }).content)) {
      switch (block.type) {
        case 'text':
          // Converse rejects a blank text block.
          if (typeof block.text === 'string' && block.text.trim()) content.push({ text: block.text })
          break
        case 'image': {
          const image = imageBlock(block)
          if (image) content.push(image)
          break
        }
        case 'document': {
          const document = documentBlock(block, ++documents.n)
          if (document) content.push(document)
          break
        }
        case 'tool_use':
          content.push(
            options.toolBlocks
              ? { toolUse: { toolUseId: String(block.id), name: String(block.name), input: block.input ?? {} } }
              : { text: toolUseAsText(block) },
          )
          break
        case 'tool_result':
          content.push(
            options.toolBlocks
              ? {
                  toolResult: {
                    toolUseId: String(block.tool_use_id),
                    content: toolResultContent(block, documents),
                    status: block.is_error ? 'error' : 'success',
                  },
                }
              : { text: toolResultAsText(block) },
          )
          break
        default:
          // thinking, redacted_thinking and server-side blocks stay behind.
          break
      }
    }
    if (content.length === 0) continue
    const last = out.at(-1)
    // Dropping blocks can leave two turns of one role in a row; Converse
    // wants them alternating, so they merge.
    if (last?.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  return out
}

function systemBlocks(system: unknown): Array<{ text: string }> {
  if (typeof system === 'string') return system.trim() ? [{ text: system }] : []
  if (!Array.isArray(system)) return []
  return (system as Block[])
    .filter(block => typeof block?.text === 'string' && block.text.trim())
    .map(block => ({ text: String(block.text) }))
}

type ToolDefinition = { name?: string; description?: string; input_schema?: Record<string, unknown>; type?: string }

function toolConfig(
  tools: ToolDefinition[],
  choice: { type?: string; name?: string } | undefined,
): Record<string, unknown> | undefined {
  // Server tools (web search and the like) carry a type and no schema.
  const specs = tools
    .filter(tool => tool.name && tool.input_schema)
    .map(tool => ({
      toolSpec: {
        name: tool.name,
        ...(tool.description && { description: tool.description }),
        inputSchema: { json: tool.input_schema },
      },
    }))
  if (specs.length === 0) return undefined
  const toolChoice =
    choice?.type === 'any'
      ? { any: {} }
      : choice?.type === 'tool' && choice.name
        ? { tool: { name: choice.name } }
        : choice?.type === 'auto'
          ? { auto: {} }
          : undefined
  return { tools: specs, ...(toolChoice && { toolChoice }) }
}

type Params = {
  model?: unknown
  system?: unknown
  messages?: Array<{ role?: string; message?: { role?: string; content?: unknown }; content?: unknown }>
  tools?: unknown
  tool_choice?: { type?: string; name?: string }
  max_tokens?: unknown
  temperature?: unknown
  top_p?: unknown
  stop_sequences?: unknown
}

export function buildConverseInput(input: Record<string, unknown>): Record<string, unknown> {
  const params = input as Params
  const tools = Array.isArray(params.tools) ? (params.tools as ToolDefinition[]) : []
  const config = params.tool_choice?.type === 'none' ? undefined : toolConfig(tools, params.tool_choice)
  // The stable stubs run at the API boundary, as on every other wire.
  const messages = applyStableInputStubs(applyStableStubs(params.messages ?? []))
  const inferenceConfig: Record<string, unknown> = {}
  if (typeof params.max_tokens === 'number') inferenceConfig.maxTokens = params.max_tokens
  if (typeof params.temperature === 'number') inferenceConfig.temperature = params.temperature
  if (typeof params.top_p === 'number') inferenceConfig.topP = params.top_p
  if (Array.isArray(params.stop_sequences) && params.stop_sequences.length > 0) {
    inferenceConfig.stopSequences = params.stop_sequences
  }
  const system = systemBlocks(params.system)
  return {
    modelId: params.model,
    messages: convertMessages(messages, { toolBlocks: config !== undefined }),
    ...(system.length > 0 && { system }),
    ...(Object.keys(inferenceConfig).length > 0 && { inferenceConfig }),
    ...(config && { toolConfig: config }),
  }
}
