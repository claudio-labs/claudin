import * as os from 'node:os'
import { APIError } from '@anthropic-ai/sdk'
import { buildAnthropicUsageFromRawUsage } from './cacheMetrics.js'
import { applyStableStubs } from '../compact/stableStubState.js'
import { fetchWithProxyRetry } from './fetchWithProxyRetry.js'
import { stableStringify } from '../../utils/stableStringify.js'
import { getSessionId } from '../../bootstrap/state.js'
import type {
  ResolvedCodexCredentials,
  ResolvedProviderRequest,
} from './providerConfig.js'
import { isCodexBaseUrl } from './providerConfig.js'
declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }
import { sanitizeSchemaForOpenAICompat } from './openaiSchemaSanitizer.js'
import {
  createThinkTagFilter,
  stripThinkTags,
} from './thinkTagSanitizer.js'

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface AnthropicStreamEvent {
  type: string
  message?: Record<string, unknown>
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  usage?: Partial<AnthropicUsage>
}

export interface ShimCreateParams {
  model: string
  messages: Array<Record<string, unknown>>
  system?: unknown
  tools?: Array<Record<string, unknown>>
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tool_choice?: unknown
  metadata?: unknown
  [key: string]: unknown
}

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesInputItem =
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: ResponsesInputPart[]
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type ResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

type CodexSseEvent = {
  event: string
  data: Record<string, any>
}

function makeUsage(usage?: Record<string, unknown>): AnthropicUsage {
  // Single source of truth for raw → Anthropic shape. Lives in
  // cacheMetrics.ts alongside the raw-shape extractor so any new
  // provider quirk requires a one-file change and the integration test
  // can call the exact same function instead of re-implementing it.
  return buildAnthropicUsageFromRawUsage(usage)
}

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function normalizeToolUseId(toolUseId: string | undefined): {
  id: string
  callId: string
} {
  const value = (toolUseId || '').trim()
  if (!value) {
    return {
      id: 'fc_unknown',
      callId: 'call_unknown',
    }
  }
  if (value.startsWith('call_')) {
    return {
      id: `fc_${value.slice('call_'.length)}`,
      callId: value,
    }
  }
  if (value.startsWith('fc_')) {
    return {
      id: value,
      callId: `call_${value.slice('fc_'.length)}`,
    }
  }
  return {
    id: `fc_${value}`,
    callId: value,
  }
}

function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : '',
      )
      .join('\n\n')
  }
  return String(system)
}

function convertToolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')

  const chunks: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text)
      continue
    }

    if (block?.type === 'image') {
      const src = block.source
      if (src?.type === 'url' && src.url) {
        chunks.push(`[Image](${src.url})`)
      }
      continue
    }

    if (typeof block?.text === 'string') {
      chunks.push(block.text)
    }
  }

  return chunks.join('\n')
}

function convertContentBlocksToResponsesParts(
  content: unknown,
  role: 'user' | 'assistant',
): ResponsesInputPart[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return [{ type: textType, text: content }]
  }
  if (!Array.isArray(content)) {
    return [{ type: textType, text: String(content ?? '') }]
  }

  const parts: ResponsesInputPart[] = []
  for (const block of content) {
    switch (block?.type) {
      case 'text':
        parts.push({ type: textType, text: block.text ?? '' })
        break
      case 'image': {
        if (role === 'assistant') break
        const source = block.source
        if (source?.type === 'base64') {
          parts.push({
            type: 'input_image',
            image_url: `data:${source.media_type};base64,${source.data}`,
          })
        } else if (source?.type === 'url' && source.url) {
          parts.push({
            type: 'input_image',
            image_url: source.url,
          })
        }
        break
      }
      case 'thinking':
        if (block.thinking) {
          parts.push({
            type: textType,
            text: `<thinking>${block.thinking}</thinking>`,
          })
        }
        break
      case 'tool_use':
      case 'tool_result':
        break
      default:
        if (typeof block?.text === 'string') {
          parts.push({ type: textType, text: block.text })
        }
    }
  }

  return parts
}

export function convertAnthropicMessagesToResponsesInput(
  messages: Array<{ role?: string; message?: { role?: string; content?: unknown }; content?: unknown }>,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []

  for (const message of messages) {
    const inner = message.message ?? message
    const role = (inner as { role?: string }).role ?? message.role
    const content = (inner as { content?: unknown }).content

    if (role === 'user') {
      if (Array.isArray(content)) {
        const toolResults = content.filter(
          (block: { type?: string }) => block.type === 'tool_result',
        )
        const otherContent = content.filter(
          (block: { type?: string }) => block.type !== 'tool_result',
        )

        for (const toolResult of toolResults) {
          const { callId } = normalizeToolUseId(toolResult.tool_use_id)
          items.push({
            type: 'function_call_output',
            call_id: callId,
            output: (() => {
              const out = convertToolResultToText(toolResult.content)
              return toolResult.is_error ? `Error: ${out}` : out
            })(),
          })
        }

        const parts = convertContentBlocksToResponsesParts(otherContent, 'user')
        if (parts.length > 0) {
          items.push({
            type: 'message',
            role: 'user',
            content: parts,
          })
        }
        continue
      }

      items.push({
        type: 'message',
        role: 'user',
        content: convertContentBlocksToResponsesParts(content, 'user'),
      })
      continue
    }

    if (role === 'assistant') {
      const textBlocks = Array.isArray(content)
        ? content.filter((block: { type?: string }) =>
            block.type !== 'tool_use' && block.type !== 'thinking')
        : content
      const parts = convertContentBlocksToResponsesParts(textBlocks, 'assistant')
      if (parts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: parts,
        })
      }

      if (Array.isArray(content)) {
        for (const toolUse of content.filter(
          (block: { type?: string }) => block.type === 'tool_use',
        )) {
          const normalized = normalizeToolUseId(toolUse.id)
          items.push({
            type: 'function_call',
            id: normalized.id,
            call_id: normalized.callId,
            name: toolUse.name ?? 'tool',
            arguments:
              typeof toolUse.input === 'string'
                ? toolUse.input
                : JSON.stringify(toolUse.input ?? {}),
          })
        }
      }
    }
  }

  return items.filter(item =>
    item.type !== 'message' || item.content.length > 0,
  )
}

/**
 * Recursively enforces Codex strict-mode constraints on a JSON schema:
 * - Every `object` type gets `additionalProperties: false`
 * - All property keys are listed in `required`
 * - Keys that were NOT required upstream become nullable, so the model can
 *   still express "I am not passing this one" (see allowNull)
 * - Nested schemas (properties, items, anyOf/oneOf/allOf) are processed too
 */
function enforceStrictSchema(schema: unknown): Record<string, unknown> {
  const record = sanitizeSchemaForOpenAICompat(schema)

  // Codex Responses rejects JSON Schema's standard `uri` string format.
  // Keep URL validation in the tool layer and send a plain string here.
  if (record.format === 'uri') {
    delete record.format
  }

  if (record.type === 'object') {
    // OpenAI structured outputs completely forbid dynamic additionalProperties.
    // They must be set to false unconditionally.
    record.additionalProperties = false

    if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      const props = record.properties as Record<string, unknown>
      // Captured before `required` is overwritten below: it is the only
      // record of which arguments the tool actually considers optional.
      // An absent `required` is JSON Schema for "nothing is required" — the
      // same reading stripPlaceholderOptionalFields uses for MCP schemas.
      // Treating it as "everything is required" (an earlier revision did)
      // forced every argument of tools like ListMcpResources, whose schema
      // has no required list at all, so the model could never call them
      // without inventing a value.
      const originallyRequired = new Set(
        Array.isArray(record.required)
          ? record.required.filter((key): key is string => typeof key === 'string')
          : [],
      )

      const enforcedProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(props)) {
        const strictValue = enforceStrictSchema(value)
        // If the resulting schema is an empty object (no properties), OpenAI structured outputs will likely
        // strip it silently and then complain about a 'required' mismatch if it remains in the required list.
        // E.g. z.record() objects (like AskUserQuestion.answers) lose their schema due to additionalProperties 
        // restrictions. We can safely drop these from the schema sent to the LLM.
        if (
          strictValue &&
          typeof strictValue === 'object' &&
          strictValue.type === 'object' &&
          strictValue.additionalProperties === false &&
          (!strictValue.properties || Object.keys(strictValue.properties).length === 0)
        ) {
          continue
        }
        enforcedProps[key] = originallyRequired.has(key)
          ? strictValue
          : allowNull(strictValue)
      }
      record.properties = enforcedProps
      record.required = Object.keys(enforcedProps)
    } else {
      // No properties — empty required array
      record.required = []
    }
  }

  // Recurse into array items
  if ('items' in record) {
    if (Array.isArray(record.items)) {
      record.items = (record.items as unknown[]).map(item => enforceStrictSchema(item))
    } else {
      record.items = enforceStrictSchema(record.items)
    }
  }

  // Recurse into combinators
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (key in record && Array.isArray(record[key])) {
      record[key] = (record[key] as unknown[]).map(item => enforceStrictSchema(item))
    }
  }

  return record
}

/**
 * Makes an optional property nullable — OpenAI's documented way to express
 * "optional" under strict structured outputs, where every key must be in
 * `required`. Without it the model has no legal way to skip an argument and
 * invents a placeholder instead (`pages: ""`, `limit: 2000`,
 * `view: "full"`), which downstream tools then honor as a real value.
 * stripPlaceholderOptionalFields (src/utils/toolInputPlaceholders.ts) turns
 * the resulting `null` back into an absent key.
 *
 * An `enum` needs `null` in BOTH the type union and the value list, or the
 * two contradict each other. The single-schema form is used rather than
 * `anyOf: [{enum…}, {type:'null'}]` because it introduces no combinator where
 * the backend previously saw a plain property. Leaving enums un-widened is
 * what forced `AgentTool.isolation: "worktree"` onto every Codex sub-agent —
 * a single-value optional enum the model could not decline.
 *
 * `const` and combinators are still left alone: a const has exactly one legal
 * value (so widening changes nothing the strip can act on) and a combinator
 * already carries its own branch structure.
 *
 * Verified live on gpt-5.5 (2026-07-29): the backend accepts this shape,
 * enum included, and the model answers `{"limit":null,"offset":null,
 * "pages":null,"symbol":null,"view":null}` — it takes the escape hatch. Drop
 * the widening and the SAME model on the SAME request invents
 * `{"limit":1,"offset":1,"pages":"","symbol":"","view":"full"}` instead, and
 * `limit: 1` is not a placeholder the strip can catch: the read returns one
 * line and the answer is wrong. The widening, not the `required` list, is what
 * actually fixes this.
 */
function allowNull(schema: Record<string, unknown>): Record<string, unknown> {
  if ('const' in schema) return schema
  if ('anyOf' in schema || 'oneOf' in schema || 'allOf' in schema) return schema
  const type = schema.type
  if (typeof type !== 'string' || type === 'null') return schema
  if (Array.isArray(schema.enum)) {
    return { ...schema, type: [type, 'null'], enum: [...schema.enum, null] }
  }
  return { ...schema, type: [type, 'null'] }
}

export function convertToolsToResponsesTools(
  tools: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>,
): ResponsesTool[] {
  return tools
    .filter(tool => tool.name && tool.name !== 'ToolSearchTool')
    .map(tool => {
      const rawParameters = tool.input_schema ?? { type: 'object', properties: {} }
      // Codex requires strict schemas: all properties must be required. This
      // was an unsourced claim from the initial commit until 2026-07-29, when
      // sending a truthful `required` under `strict: true` was answered with
      //   400 invalid_function_parameters — "Invalid schema for function
      //   'Agent': 'required' is required to be supplied and to be an array
      //   including every key in properties. Missing 'isolation'."
      // Dropping `strict` does get the truthful list accepted, but it does not
      // help: the model keeps inventing placeholder values anyway (see
      // allowNull above), so the flag stays and the widening carries the fix.
      const parameters = enforceStrictSchema(rawParameters)

      return {
        type: 'function',
        name: tool.name ?? 'tool',
        description: tool.description ?? '',
        parameters,
        strict: true,
      }
    })
}

function convertToolChoice(toolChoice: unknown): unknown {
  const choice = toolChoice as { type?: string; name?: string } | undefined
  if (!choice?.type) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return {
      type: 'function',
      name: choice.name,
    }
  }
  return undefined
}

export async function performCodexRequest(options: {
  request: ResolvedProviderRequest
  credentials: ResolvedCodexCredentials
  params: ShimCreateParams
  defaultHeaders: Record<string, string>
  signal?: AbortSignal
}): Promise<Response> {
  // applyStableStubs runs at the API boundary so the stable bytes are
  // what goes on the wire. No ensureToolResultPairing analogue exists
  // here — convertAnthropicMessagesToResponsesInput handles orphan
  // tool_results downstream.
  const compressedMessages = applyStableStubs(
    options.params.messages as Array<{
      role?: string
      message?: { role?: string; content?: unknown }
      content?: unknown
    }>,
  )
  const input = convertAnthropicMessagesToResponsesInput(compressedMessages)
  const body: Record<string, unknown> = {
    model: options.request.resolvedModel,
    input: input.length > 0
      ? input
      : [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '' }],
          },
        ],
    store: false,
    stream: true,
    // The chatgpt.com backend honors prompt_cache_key (same as api.openai.com —
    // see openaiShim/messagesClient.ts): the key pins requests of one session to
    // the same cache-aware server (~8.5% hit rate without it). Gated on
    // isCodexBaseUrl because this transport also runs against user-supplied
    // baseUrls (local proxies), where unknown body fields can 400.
    // NOTE: prompt_cache_retention is deliberately NOT sent here — the Codex
    // backend rejects it with `400 Unsupported parameter: prompt_cache_retention`.
    ...(isCodexBaseUrl(options.request.baseUrl) && {
      prompt_cache_key: getSessionId(),
    }),
  }

  const instructions = convertSystemPrompt(options.params.system)
  if (instructions) {
    body.instructions = instructions
  }

  const toolChoice = convertToolChoice(options.params.tool_choice)
  if (toolChoice) {
    body.tool_choice = toolChoice
  }

  if (options.params.tools && options.params.tools.length > 0) {
    const convertedTools = convertToolsToResponsesTools(
      options.params.tools as Array<{
        name?: string
        description?: string
        input_schema?: Record<string, unknown>
      }>,
    )
    if (convertedTools.length > 0) {
      body.tools = convertedTools
      body.parallel_tool_calls = true
      body.tool_choice ??= 'auto'
    }
  }

  if (options.request.reasoning) {
    body.reasoning = options.request.reasoning
  }

  const isTargetModel =
    options.request.resolvedModel?.toLowerCase().includes('gpt') ||
    options.request.resolvedModel?.toLowerCase().includes('codex')

  // Only pass temperature and top_p if it's not a GPT/Codex model that rejects them
  if (!isTargetModel) {
    if (options.params.temperature !== undefined) {
      body.temperature = options.params.temperature
    }
    if (options.params.top_p !== undefined) {
      body.top_p = options.params.top_p
    }
  }

  // Match the Codex CLI's User-Agent shape: `<product>/<version> (<platform>
  // <release>; <arch>)`. The OpenAI backend soft-gates on this; OpenCode
  // (`opencode/src/plugin/openai/codex.ts:637`) sends the same parenthesized
  // OS triple. Our generic getClaudinUserAgent() shape (entrypoint, sdk
  // version) is fine for non-Codex requests but differs enough that some
  // proxies log it as "unknown client".
  const codexUserAgent = `claudin/${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`

  // NOTE on ordering: Codex-specific overrides MUST come after the
  // `...options.defaultHeaders` spread. The SDK client builds defaultHeaders
  // with a generic `User-Agent` (see client.ts) which would otherwise win
  // over our Codex-CLI-shaped one. `Authorization` is last to defeat any
  // bearer the SDK may have inherited.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.defaultHeaders,
    'User-Agent': codexUserAgent,
    Authorization: `Bearer ${options.credentials.apiKey}`,
  }
  if (options.credentials.accountId) {
    // Canonical casing matches the Codex CLI / OpenCode wire format. HTTP
    // is case-insensitive on the line, but some intermediate proxies and
    // log pipelines fingerprint canonical case.
    headers['ChatGPT-Account-Id'] = options.credentials.accountId
  }
  // Session affinity + rate-limit/abuse signals on the OpenAI Codex
  // backend. OpenCode sets this from input.sessionID; we use our own
  // process-wide session id. Required on long sessions for WS continuity.
  headers['session-id'] = getSessionId()
  // NOTE: we intentionally do not set `max_output_tokens` on the body
  // above. The Codex CLI strips it, and so does OpenCode (`chat.params`
  // → `output.maxOutputTokens = undefined`). performCodexRequest builds
  // the body from scratch and only forwards the fields Codex accepts,
  // so no upstream `params.max_tokens` leak is possible here.
  headers.originator ??= 'claudin'

  // Defensive URL normalization: if a user's profile stored a baseUrl that
  // already includes `/v1/responses` or `/chat/completions` (a common
  // OpenAI-compatible-style misconfiguration), naive concatenation would
  // produce `…/responses/responses` and 404. Match OpenCode
  // (`codex.ts:500-503`): collapse to the canonical Codex responses
  // endpoint when those telltale segments appear.
  const codexUrl = (() => {
    const raw = `${options.request.baseUrl}/responses`
    try {
      const parsed = new URL(raw)
      if (
        parsed.pathname.includes('/v1/responses') ||
        parsed.pathname.includes('/chat/completions')
      ) {
        return `${parsed.origin}/backend-api/codex/responses`
      }
      return raw
    } catch {
      return raw
    }
  })()

  const response = await fetchWithProxyRetry(
    codexUrl,
    {
      method: 'POST',
      headers,
      // WHY: byte-identity required for implicit prefix caching on
      // OpenAI Responses API. See src/utils/stableStringify.ts.
      body: stableStringify(body),
      signal: options.signal,
    },
    { provider: 'codex' },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'unknown error')
    let errorResponse: object | undefined
    try { errorResponse = JSON.parse(errorBody) } catch { /* raw text */ }
    throw APIError.generate(
      response.status, errorResponse,
      `Codex API error ${response.status}: ${errorBody}`,
      response.headers as unknown as Headers,
    )
  }

  return response
}

async function* readSseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<CodexSseEvent> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''
  const STREAM_IDLE_TIMEOUT_MS = 120_000 // 2 minutes without data
  let lastDataTime = Date.now()

  /**
   * Read from the stream with an idle timeout. Respects the caller's
   * AbortSignal — clears the idle timer on abort so the AbortError
   * surfaces cleanly instead of a spurious idle timeout.
   */
  async function readWithTimeout(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const elapsed = Math.round((Date.now() - lastDataTime) / 1000)
        reject(new Error(
          `Codex SSE stream idle for ${elapsed}s (limit: ${STREAM_IDLE_TIMEOUT_MS / 1000}s). Connection likely dropped.`,
        ))
      }, STREAM_IDLE_TIMEOUT_MS)

      let abortCleanup: (() => void) | undefined
      if (signal) {
        abortCleanup = () => {
          clearTimeout(timeoutId)
        }
        signal.addEventListener('abort', abortCleanup, { once: true })
      }

      reader.read().then(
        result => {
          clearTimeout(timeoutId)
          if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
          if (result.value) lastDataTime = Date.now()
          resolve(result)
        },
        err => {
          clearTimeout(timeoutId)
          if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
          reject(err)
        },
      )
    })
  }

  while (true) {
    const { done, value } = await readWithTimeout()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const lines = chunk
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      if (lines.length === 0) continue

      const eventLine = lines.find(line => line.startsWith('event: '))
      const dataLines = lines.filter(line => line.startsWith('data: '))
      if (!eventLine || dataLines.length === 0) continue

      const event = eventLine.slice(7).trim()
      const rawData = dataLines.map(line => line.slice(6)).join('\n')
      if (rawData === '[DONE]') continue

      let data: Record<string, any>
      try {
        const parsed = JSON.parse(rawData)
        if (!parsed || typeof parsed !== 'object') continue
        data = parsed as Record<string, any>
      } catch {
        continue
      }

      yield { event, data }
    }
  }
}

function determineStopReason(
  response: Record<string, any> | undefined,
  sawToolUse: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  const output = Array.isArray(response?.output) ? response.output : []
  if (
    sawToolUse ||
    output.some((item: { type?: string }) => item?.type === 'function_call')
  ) {
    return 'tool_use'
  }

  const incompleteReason = response?.incomplete_details?.reason
  if (
    typeof incompleteReason === 'string' &&
    incompleteReason.includes('max_output_tokens')
  ) {
    return 'max_tokens'
  }

  return 'end_turn'
}

export async function collectCodexCompletedResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  let completedResponse: Record<string, any> | undefined

  for await (const event of readSseEvents(response, signal)) {
    if (event.event === 'response.failed') {
      const msg = event.data?.response?.error?.message ??
        event.data?.error?.message ?? 'Codex response failed'
      throw APIError.generate(500, undefined, msg, new Headers())
    }

    if (
      event.event === 'response.completed' ||
      event.event === 'response.incomplete'
    ) {
      completedResponse = event.data?.response
      break
    }
  }

  if (!completedResponse) {
    throw APIError.generate(
      500, undefined, 'Codex response ended without a completed payload',
      new Headers(),
    )
  }

  return completedResponse
}

export async function* codexStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const messageId = makeMessageId()
  const toolBlocksByItemId = new Map<
    string,
    { index: number; toolUseId: string }
  >()
  let activeTextBlockIndex: number | null = null
  const thinkFilter = createThinkTagFilter()
  let nextContentBlockIndex = 0
  let sawToolUse = false
  let finalResponse: Record<string, any> | undefined

  const closeActiveTextBlock = async function* () {
    if (activeTextBlockIndex === null) return
    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: activeTextBlockIndex,
        delta: {
          type: 'text_delta',
          text: tail,
        },
      }
    }
    yield {
      type: 'content_block_stop',
      index: activeTextBlockIndex,
    }
    activeTextBlockIndex = null
  }

  const startTextBlockIfNeeded = async function* () {
    if (activeTextBlockIndex !== null) return
    activeTextBlockIndex = nextContentBlockIndex++
    yield {
      type: 'content_block_start',
      index: activeTextBlockIndex,
      content_block: { type: 'text', text: '' },
    }
  }

  yield {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: makeUsage(),
    },
  }

  for await (const event of readSseEvents(response, signal)) {
    const payload = event.data

    if (event.event === 'response.output_item.added') {
      const item = payload.item
      if (item?.type === 'function_call') {
        yield* closeActiveTextBlock()
        const blockIndex = nextContentBlockIndex++
        const toolUseId = item.call_id ?? item.id ?? `call_${blockIndex}`
        toolBlocksByItemId.set(String(item.id ?? toolUseId), {
          index: blockIndex,
          toolUseId,
        })
        sawToolUse = true

        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: item.name ?? 'tool',
            input: {},
          },
        }

        if (item.arguments) {
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: item.arguments,
            },
          }
        }
      }
      continue
    }

    if (event.event === 'response.content_part.added') {
      if (payload.part?.type === 'output_text') {
        yield* startTextBlockIfNeeded()
      }
      continue
    }

    if (event.event === 'response.output_text.delta') {
      yield* startTextBlockIfNeeded()
      if (activeTextBlockIndex !== null) {
        const visible = thinkFilter.feed(payload.delta ?? '')
        if (visible) {
          yield {
            type: 'content_block_delta',
            index: activeTextBlockIndex,
            delta: {
              type: 'text_delta',
              text: visible,
            },
          }
        }
      }
      continue
    }

    if (event.event === 'response.function_call_arguments.delta') {
      const toolBlock = toolBlocksByItemId.get(String(payload.item_id ?? ''))
      if (toolBlock) {
        yield {
          type: 'content_block_delta',
          index: toolBlock.index,
          delta: {
            type: 'input_json_delta',
            partial_json: payload.delta ?? '',
          },
        }
      }
      continue
    }

    if (event.event === 'response.output_item.done') {
      const item = payload.item
      if (item?.type === 'function_call') {
        const toolBlock = toolBlocksByItemId.get(String(item.id ?? ''))
        if (toolBlock) {
          yield {
            type: 'content_block_stop',
            index: toolBlock.index,
          }
          toolBlocksByItemId.delete(String(item.id))
        }
      } else if (item?.type === 'message') {
        yield* closeActiveTextBlock()
      }
      continue
    }

    if (
      event.event === 'response.completed' ||
      event.event === 'response.incomplete'
    ) {
      finalResponse = payload.response
      break
    }

    if (event.event === 'response.failed') {
      const msg = payload?.response?.error?.message ??
        payload?.error?.message ?? 'Codex response failed'
      throw APIError.generate(500, undefined, msg, new Headers())
    }
  }

  yield* closeActiveTextBlock()
  for (const toolBlock of toolBlocksByItemId.values()) {
    yield {
      type: 'content_block_stop',
      index: toolBlock.index,
    }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: determineStopReason(finalResponse, sawToolUse),
      stop_sequence: null,
    },
    // Delegate to the shared normalizer so the streaming message_delta
    // path uses the same raw→Anthropic conversion as makeUsage() above
    // and the non-streaming response converter below. Previously this
    // block had its own inline subtraction that missed Kimi / DeepSeek
    // / Gemini raw shapes that the shared helper handles.
    usage: makeUsage(
      finalResponse?.usage as Record<string, unknown> | undefined,
    ),
  }
  yield { type: 'message_stop' }
}

export function convertCodexResponseToAnthropicMessage(
  data: Record<string, any>,
  model: string,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  const output = Array.isArray(data.output) ? data.output : []

  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text') {
          content.push({
            type: 'text',
            text: stripThinkTags(part.text ?? ''),
          })
        }
      }
      continue
    }

    if (item?.type === 'function_call') {
      let input: unknown
      try {
        input = JSON.parse(item.arguments ?? '{}')
      } catch {
        input = { raw: item.arguments ?? '' }
      }

      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? makeMessageId(),
        name: item.name ?? 'tool',
        input,
      })
    }
  }

  return {
    id: data.id ?? makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: data.model ?? model,
    stop_reason: determineStopReason(data, content.some(item => item.type === 'tool_use')),
    stop_sequence: null,
    usage: makeUsage(data.usage),
  }
}
