import type { Anthropic } from '@anthropic-ai/sdk'
import type { BetaMessageParam as MessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
// @aws-sdk/client-bedrock-runtime is imported dynamically in countTokensWithBedrock()
// to defer ~279KB of AWS SDK code until a Bedrock call is actually made
import type { CountTokensCommandInput } from '@aws-sdk/client-bedrock-runtime'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { VERTEX_COUNT_TOKENS_ALLOWED_BETAS } from '../constants/betas.js'
import type { Attachment } from '../utils/attachments.js'
import { getModelBetas } from '../utils/betas.js'
import { estimateImageTokens } from '../utils/imageTokenEstimator.js'
import { getVertexRegionForModel, isEnvTruthy } from '../utils/envUtils.js'
import { tryGetActiveProvider } from './api/activeProvider.js'
import { logError } from '../utils/log.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import {
  createBedrockRuntimeClient,
  getInferenceProfileBackingModel,
  isFoundationModel,
} from '../utils/model/bedrock.js'
import {
  getDefaultSonnetModel,
  getMainLoopModel,
  getSmallFastModel,
  normalizeModelStringForAPI,
} from '../utils/model/model.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { getAnthropicClient } from './api/client.js'
import { withTokenCountVCR } from './vcr.js'

// Minimal values for token counting with thinking enabled
// API constraint: max_tokens must be greater than thinking.budget_tokens
const TOKEN_COUNT_THINKING_BUDGET = 1024
const TOKEN_COUNT_MAX_TOKENS = 2048

/**
 * Check if messages contain thinking blocks
 */
function hasThinkingBlocks(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block.type === 'thinking' || block.type === 'redacted_thinking')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Strip tool search-specific fields from messages before sending for token counting.
 * This removes 'caller' from tool_use blocks and 'tool_reference' from tool_result content.
 * These fields are only valid with the tool search beta and will cause errors otherwise.
 *
 * Note: We use 'as unknown as' casts because the SDK types don't include tool search beta fields,
 * but at runtime these fields may exist from API responses when tool search was enabled.
 */
function stripToolSearchFieldsFromMessages(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
): Anthropic.Beta.Messages.BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) {
      return message
    }

    const normalizedContent = message.content.map(block => {
      // Strip 'caller' from tool_use blocks (assistant messages)
      if (block.type === 'tool_use') {
        // Destructure to exclude any extra fields like 'caller'
        const toolUse =
          block as Anthropic.Beta.Messages.BetaToolUseBlockParam & {
            caller?: unknown
          }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      // Strip tool_reference blocks from tool_result content (user messages)
      if (block.type === 'tool_result') {
        const toolResult =
          block as Anthropic.Beta.Messages.BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filteredContent = (toolResult.content as unknown[]).filter(
            c => !isToolReferenceBlock(c),
          ) as typeof toolResult.content

          if (filteredContent.length === 0) {
            return {
              ...toolResult,
              content: [{ type: 'text' as const, text: '[tool references]' }],
            }
          }
          if (filteredContent.length !== toolResult.content.length) {
            return {
              ...toolResult,
              content: filteredContent,
            }
          }
        }
      }

      return block
    })

    return {
      ...message,
      content: normalizedContent,
    }
  })
}

export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  // Special case for empty content - API doesn't accept empty messages
  if (!content) {
    return 0
  }

  const message: Anthropic.Beta.Messages.BetaMessageParam = {
    role: 'user',
    content: content,
  }

  return countMessagesTokensWithAPI([message], [])
}

export async function countMessagesTokensWithAPI(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    try {
      const model = getMainLoopModel()
      const betas = getModelBetas(model)
      const containsThinking = hasThinkingBlocks(messages)

      if (getAPIProvider() === 'bedrock') {
        // @anthropic-sdk/bedrock-sdk doesn't support countTokens currently
        return countTokensWithBedrock({
          model: normalizeModelStringForAPI(model),
          messages,
          tools,
          betas,
          containsThinking,
        })
      }

      const anthropic = await getAnthropicClient({
        maxRetries: 1,
        model,
        source: 'count_tokens',
      })

      const filteredBetas =
        getAPIProvider() === 'vertex'
          ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
          : betas

      const response = await anthropic.beta.messages.countTokens({
        model: normalizeModelStringForAPI(model),
        messages:
          // When we pass tools and no messages, we need to pass a dummy message
          // to get an accurate tool token count.
          messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
        tools,
        ...(filteredBetas.length > 0 && { betas: filteredBetas }),
        // Enable thinking if messages contain thinking blocks
        ...(containsThinking && {
          thinking: {
            type: 'enabled',
            budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
          },
        }),
      })

      if (typeof response.input_tokens !== 'number') {
        // Vertex client throws
        // Bedrock client succeeds with { Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' }
        return null
      }

      return response.input_tokens
    } catch (error) {
      logError(error)
      return null
    }
  })
}

/**
 * Module-level memoized ratios per model name. `roughTokenCountEstimation`
 * is invoked 1000-3000× per turn from microCompact/analyzeContext/tokens.ts,
 * so we avoid re-running `getBytesPerTokenForModel` (which walks the family
 * regex table) on every call. Keyed by model name so sub-agent code paths
 * using a different model (e.g. small-fast) coexist without thrashing the
 * cache. Bounded in practice — only a handful of model names per session.
 */
const memoizedRatios = new Map<string, number>()

/**
 * Returns the bytes-per-token ratio for the active main-loop model, or 4
 * if no provider is initialised (early bootstrap, offline scripts, tests
 * without a mocked provider).
 *
 * Exported so callers that need the raw ratio (e.g. SessionMemory section
 * sizing) don't have to round-trip through `roughTokenCountEstimation`.
 */
export function getActiveModelBytesPerToken(): number {
  try {
    const model = getMainLoopModel()
    const cached = memoizedRatios.get(model)
    if (cached !== undefined) return cached
    const ratio = getBytesPerTokenForModel(model)
    memoizedRatios.set(model, ratio)
    return ratio
  } catch {
    return 4
  }
}

/**
 * Test-only: clear the model-ratio cache. Production code never needs this —
 * cache is keyed by model name so it self-invalidates on `/provider` switch.
 */
export function __resetMemoizedRatiosForTests(): void {
  memoizedRatios.clear()
}

/**
 * Estimate token count for a string. When `bytesPerToken` is omitted the
 * ratio is resolved from the active main-loop model via
 * `MODEL_TOKENIZER_CONFIGS`, so estimates calibrate to the provider in use
 * (Claude/Gemini/DeepSeek/etc.) instead of always assuming 4 bytes/token.
 *
 * Pass an explicit ratio for content-type-specific overrides (e.g. JSON=2
 * via `roughTokenCountEstimationForFileType`).
 */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken?: number,
): number {
  const ratio = bytesPerToken ?? getActiveModelBytesPerToken()
  return Math.round(content.length / ratio)
}

/**
 * Returns an estimated bytes-per-token ratio for a given file extension.
 * Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * which makes the real ratio closer to 2 rather than the default 4.
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Tokenizer ratio by model family.
 * Different models have different encodings.
 */
export interface ModelTokenizerConfig {
  modelFamily: string
  bytesPerToken: number
  supportsJson: boolean
  supportsCode: boolean
}

// Ratios sourced from official tokenizer docs / public empirical analyses
// (snapshot 2026-04). Under-estimating is worse than over-estimating —
// autoCompact fires late — so values are rounded up conservatively when
// sources disagree.
export const MODEL_TOKENIZER_CONFIGS: ModelTokenizerConfig[] = [
  { modelFamily: 'claude', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  { modelFamily: 'gpt-5', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  { modelFamily: 'gpt-4', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  { modelFamily: 'gpt-3.5', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  // Gemini SentencePiece Unigram (256k vocab): ~4 chars/token oficial Google,
  // 4.2 empírico. Antes era 3.5 — subestimava contexto em ~14%.
  { modelFamily: 'gemini', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  { modelFamily: 'llama', bytesPerToken: 3.8, supportsJson: true, supportsCode: true },
  { modelFamily: 'mistral', bytesPerToken: 3.8, supportsJson: true, supportsCode: true },
  // Devstral is Mistral's coding model — same tokenizer family.
  { modelFamily: 'devstral', bytesPerToken: 3.8, supportsJson: true, supportsCode: true },
  { modelFamily: 'deepseek', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  { modelFamily: 'qwen', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  { modelFamily: 'glm', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  // Grok (xAI) — proprietary tokenizer, ~4 chars/token typical for English BPE.
  { modelFamily: 'grok', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  // Cohere Command — proprietary tokenizer (~4 chars/token per docs).
  { modelFamily: 'command', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  { modelFamily: 'cohere', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  // Gemma (Google open-weights) — shares tokenizer with Gemini (~4 chars/token).
  { modelFamily: 'gemma', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  // Phi (Microsoft) — uses tiktoken cl100k variants, ~4 chars/token.
  { modelFamily: 'phi', bytesPerToken: 4, supportsJson: true, supportsCode: true },
  // Moonshot/Kimi (kimi-k2, kimi-for-coding) — proprietary tokenizer, ~3.5 empirical.
  { modelFamily: 'kimi', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  { modelFamily: 'moonshot', bytesPerToken: 3.5, supportsJson: true, supportsCode: true },
  { modelFamily: 'minimax', bytesPerToken: 3.2, supportsJson: true, supportsCode: true },
]

/**
 * Get tokenizer config for a model. Matches the family name as a token
 * boundary (non-alphanumeric on either side, or string edge), so short
 * names like `phi` / `command` / `glm` don't accidentally match
 * `morpheus`, `slash-command`, or `algorithm`.
 */
export function getTokenizerConfig(model: string): ModelTokenizerConfig {
  const lower = model.toLowerCase()

  for (const config of MODEL_TOKENIZER_CONFIGS) {
    const escaped = config.modelFamily.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`)
    if (re.test(lower)) {
      return config
    }
  }

  return { modelFamily: 'unknown', bytesPerToken: 4, supportsJson: true, supportsCode: true }
}

/**
 * Get bytes-per-token ratio for a model.
 */
export function getBytesPerTokenForModel(model: string): number {
  return getTokenizerConfig(model).bytesPerToken
}

/**
 * Like {@link roughTokenCountEstimation} but uses a more accurate
 * bytes-per-token ratio when the file type is known.
 *
 * This matters when the API-based token count is unavailable (e.g. on
 * Bedrock) and we fall back to the rough estimate — an underestimate can
 * let an oversized tool result slip into the conversation.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/**
 * Estimates token count for a Message object by extracting and analyzing its text content.
 * This provides a more reliable estimate than getTokenUsage for messages that may have been compacted.
 * Uses Haiku for token counting (Haiku 4.5 supports thinking blocks), except:
 * - Vertex global region: uses Sonnet (Haiku not available)
 * - Bedrock with thinking blocks: uses Sonnet (Haiku 3.5 doesn't support thinking)
 */
export async function countTokensViaHaikuFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  // Check if messages contain thinking blocks
  const containsThinking = hasThinkingBlocks(messages)

  const transport = tryGetActiveProvider()?.transport
  // If we're on Vertex and using global region, always use Sonnet since Haiku is not available there.
  const isVertexGlobalEndpoint =
    transport === 'vertex' &&
    getVertexRegionForModel(getSmallFastModel()) === 'global'
  // If we're on Bedrock with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isBedrockWithThinking = transport === 'bedrock' && containsThinking
  // If we're on Vertex with thinking blocks, use Sonnet since Haiku 3.5 doesn't support thinking
  const isVertexWithThinking = transport === 'vertex' && containsThinking
  // Otherwise always use Haiku - Haiku 4.5 supports thinking blocks.
  // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
  // Note: We don't need Sonnet for tool_reference blocks because we strip them via
  // stripToolSearchFieldsFromMessages() before sending.
  // Use getSmallFastModel() to respect ANTHROPIC_SMALL_FAST_MODEL env var for Bedrock users
  // with global inference profiles (see issue #10883).
  const model =
    isVertexGlobalEndpoint || isBedrockWithThinking || isVertexWithThinking
      ? getDefaultSonnetModel()
      : getSmallFastModel()
  const anthropic = await getAnthropicClient({
    maxRetries: 1,
    model,
    source: 'count_tokens',
  })

  // Strip tool search-specific fields (caller, tool_reference) before sending
  // These fields are only valid with the tool search beta header
  const normalizedMessages = stripToolSearchFieldsFromMessages(messages)

  const messagesToSend: MessageParam[] =
    normalizedMessages.length > 0
      ? (normalizedMessages as MessageParam[])
      : [{ role: 'user', content: 'count' }]

  const betas = getModelBetas(model)
  // Filter betas for Vertex - some betas (like web-search) cause 400 errors
  // on certain Vertex endpoints. See issue #10789.
  const filteredBetas =
    getAPIProvider() === 'vertex'
      ? betas.filter(b => VERTEX_COUNT_TOKENS_ALLOWED_BETAS.has(b))
      : betas

  // Use countTokens (free) instead of messages.create (charges real tokens).
  // countTokens supports the same thinking/tools/betas params we need.
  // Returns only `input_tokens` (cache_creation/cache_read are folded in
  // server-side); matches the primary path in countMessagesTokensWithAPI.
  const response = await anthropic.beta.messages.countTokens({
    model: normalizeModelStringForAPI(model),
    messages: messagesToSend,
    tools: tools.length > 0 ? tools : undefined,
    ...(filteredBetas.length > 0 && { betas: filteredBetas }),
    // Enable thinking if messages contain thinking blocks
    ...(containsThinking && {
      thinking: {
        type: 'enabled',
        budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
      },
    }),
  })

  if (typeof response.input_tokens !== 'number') {
    return null
  }

  return response.input_tokens
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message?.content as
        | string
        | Array<Anthropic.ContentBlock>
        | Array<Anthropic.ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    const userMessages = normalizeAttachmentForAPI(message.attachment)
    let total = 0
    for (const userMsg of userMessages) {
      total += roughTokenCountEstimationForContent(userMsg.message.content)
    }
    return total
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content:
    | string
    | Array<Anthropic.ContentBlock>
    | Array<Anthropic.ContentBlockParam>
    | undefined,
): number {
  if (!content) {
    return 0
  }
  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }
  let totalTokens = 0
  for (const block of content) {
    totalTokens += roughTokenCountEstimationForBlock(block)
  }
  return totalTokens
}

function roughTokenCountEstimationForBlock(
  block: string | Anthropic.ContentBlock | Anthropic.ContentBlockParam,
): number {
  if (typeof block === 'string') {
    return roughTokenCountEstimation(block)
  }
  if (block.type === 'text') {
    return roughTokenCountEstimation(block.text)
  }
  if (block.type === 'image') {
    // Per-provider vision pricing — see utils/imageTokenEstimator.ts. Falls
    // back to the legacy 2000 when the source is a URL, the header cannot be
    // parsed, or the provider has no documented vision formula.
    return estimateImageTokens(block.source)
  }
  if (block.type === 'document') {
    // base64 PDF in source.data. Must NOT reach the jsonStringify catch-all —
    // a 1MB PDF is ~1.33M base64 chars → ~325k estimated tokens, vs the
    // ~2000 the API actually charges. Page-accurate sizing is out of scope.
    return 2000
  }
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_use') {
    // input is the JSON the model generated — arbitrarily large (bash
    // commands, Edit diffs, file contents).  Stringify once for the
    // char count; the API re-serializes anyway so this is what it sees.
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  // server_tool_use, web_search_tool_result, mcp_tool_use, etc. —
  // text-like payloads (tool inputs, search results, no base64).
  // Stringify-length tracks the serialized form the API sees; the
  // key/bracket overhead is single-digit percent on real blocks.
  return roughTokenCountEstimation(jsonStringify(block))
}

async function countTokensWithBedrock({
  model,
  messages,
  tools,
  betas,
  containsThinking,
}: {
  model: string
  messages: Anthropic.Beta.Messages.BetaMessageParam[]
  tools: Anthropic.Beta.Messages.BetaToolUnion[]
  betas: string[]
  containsThinking: boolean
}): Promise<number | null> {
  try {
    const client = await createBedrockRuntimeClient()
    // Bedrock CountTokens requires a model ID, not an inference profile / ARN
    const modelId = isFoundationModel(model)
      ? model
      : await getInferenceProfileBackingModel(model)
    if (!modelId) {
      return null
    }

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      // When we pass tools and no messages, we need to pass a dummy message
      // to get an accurate tool token count.
      messages:
        messages.length > 0 ? messages : [{ role: 'user', content: 'foo' }],
      max_tokens: containsThinking ? TOKEN_COUNT_MAX_TOKENS : 1,
      ...(tools.length > 0 && { tools }),
      ...(betas.length > 0 && { anthropic_beta: betas }),
      ...(containsThinking && {
        thinking: {
          type: 'enabled',
          budget_tokens: TOKEN_COUNT_THINKING_BUDGET,
        },
      }),
    }

    const { CountTokensCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    )
    const input: CountTokensCommandInput = {
      modelId,
      input: {
        invokeModel: {
          body: new TextEncoder().encode(jsonStringify(requestBody)),
        },
      },
    }
    const response = await client.send(new CountTokensCommand(input))
    const tokenCount = response.inputTokens ?? null
    return tokenCount
  } catch (error) {
    logError(error)
    return null
  }
}
