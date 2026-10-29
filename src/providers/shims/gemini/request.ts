/**
 * Anthropic Messages → a Gemini `generateContent` body, as gemini-cli lays it
 * out (packages/core/src/core/geminiChat.ts and tools/tools.ts):
 *
 * - `system` becomes `systemInstruction`; user/assistant become user/model.
 * - A tool_use is a `functionCall` carrying its `thoughtSignature`. Gemini 3
 *   validates the signature on the first call of each model turn, so a call
 *   without one gets the synthetic value gemini-cli sends,
 *   `skip_thought_signature_validator`.
 * - Thinking text is never sent back (gemini-cli drops thought parts from
 *   history); its signature goes on the first text part of a turn that has no
 *   function call.
 * - A tool_result is a `functionResponse` under the name of the call it
 *   answers. Images in it travel inside the response on Gemini 3, next to it
 *   on earlier models.
 * - Tools are `functionDeclarations` with the input schema as
 *   `parametersJsonSchema`, unsanitized.
 */
import {
  applyStableInputStubs,
  applyStableStubs,
} from 'src/agent/compact/stableStubState.js'
import type { ShimCreateParams } from 'src/providers/shims/codexShim.js'
import { geminiVersion } from 'src/providers/shims/gemini/endpoints.js'
import { geminiThinkingConfig } from 'src/providers/shims/gemini/thinking.js'
import { convertSystemPrompt } from 'src/providers/shims/openaiShim/messageConverter.js'

const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

type GeminiPart = Record<string, unknown>
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

type Block = Record<string, any>

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? (content as Block[]) : []
}

function mediaPart(block: Block): GeminiPart | undefined {
  const source = block.source as Block | undefined
  if (!source) return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    return { inlineData: { mimeType: source.media_type, data: source.data } }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { fileData: { fileUri: source.url } }
  }
  if (source.type === 'text' && typeof source.data === 'string') {
    return { text: source.data }
  }
  return undefined
}

function signatureOf(block: Block): string | undefined {
  const own = typeof block.signature === 'string' ? block.signature : undefined
  const compat = block.extra_content?.google?.thought_signature
  return own || (typeof compat === 'string' && compat ? compat : undefined)
}

function modelParts(content: unknown, callNames: Map<string, string>): GeminiPart[] {
  const parts: GeminiPart[] = []
  let thinkingSignature: string | undefined
  for (const block of blocksOf(content)) {
    if (block.type === 'text') {
      if (block.text) parts.push({ text: block.text })
    } else if (block.type === 'thinking') {
      if (block.signature) thinkingSignature ??= block.signature
    } else if (block.type === 'tool_use') {
      callNames.set(block.id, block.name)
      const signature = signatureOf(block)
      parts.push({
        functionCall: { id: block.id, name: block.name, args: block.input ?? {} },
        ...(signature && { thoughtSignature: signature }),
      })
    }
  }
  const firstCall = parts.find(part => part.functionCall)
  if (firstCall) {
    firstCall.thoughtSignature ??= SYNTHETIC_THOUGHT_SIGNATURE
  } else if (thinkingSignature) {
    const firstText = parts.find(part => typeof part.text === 'string')
    if (firstText) firstText.thoughtSignature = thinkingSignature
  }
  return parts
}

function toolResultText(content: unknown): { text: string; media: GeminiPart[] } {
  if (typeof content === 'string') return { text: content, media: [] }
  const texts: string[] = []
  const media: GeminiPart[] = []
  for (const block of blocksOf(content)) {
    if (block.type === 'text') texts.push(block.text ?? '')
    else {
      const part = mediaPart(block)
      if (part?.text !== undefined) texts.push(String(part.text))
      else if (part) media.push(part)
    }
  }
  return { text: texts.join('\n'), media }
}

function userParts(
  content: unknown,
  callNames: Map<string, string>,
  mediaInResponse: boolean,
): GeminiPart[] {
  const responses: GeminiPart[] = []
  const rest: GeminiPart[] = []
  for (const block of blocksOf(content)) {
    if (block.type === 'tool_result') {
      const { text, media } = toolResultText(block.content)
      responses.push({
        functionResponse: {
          id: block.tool_use_id,
          name: callNames.get(block.tool_use_id) ?? 'unknown',
          response: block.is_error ? { error: text } : { output: text },
          ...(mediaInResponse && media.length > 0 && { parts: media }),
        },
      })
      if (!mediaInResponse) rest.push(...media)
    } else if (block.type === 'text') {
      if (block.text) rest.push({ text: block.text })
    } else {
      const part = mediaPart(block)
      if (part) rest.push(part)
    }
  }
  // Gemini pairs a model turn's calls with the responses that open the next.
  return [...responses, ...rest]
}

export function convertMessagesToGeminiContents(
  messages: ReadonlyArray<Record<string, unknown>>,
  model: string,
): GeminiContent[] {
  const callNames = new Map<string, string>()
  const mediaInResponse = (geminiVersion(model) ?? 0) >= 3
  const contents: GeminiContent[] = []
  for (const message of messages) {
    const inner = message.message as Block | undefined
    const role = (message.role ?? inner?.role) === 'assistant' ? 'model' : 'user'
    const content = message.content ?? inner?.content
    const parts =
      role === 'model'
        ? modelParts(content, callNames)
        : userParts(content, callNames, mediaInResponse)
    if (parts.length === 0) continue
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  return contents
}

function convertTools(tools: ShimCreateParams['tools']): GeminiPart[] | undefined {
  const declarations = (tools ?? [])
    .filter(tool => !tool.type || tool.type === 'function' || tool.type === 'custom')
    .map(tool => {
      const { $schema: _schema, ...schema } = (tool.input_schema as Block | undefined) ?? {
        type: 'object',
        properties: {},
      }
      return {
        name: tool.name,
        description: tool.description ?? '',
        parametersJsonSchema: schema,
      }
    })
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined
}

function convertToolChoice(toolChoice: unknown): GeminiPart | undefined {
  const choice = toolChoice as { type?: string; name?: string } | undefined
  if (choice?.type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (choice?.type === 'any') return { functionCallingConfig: { mode: 'ANY' } }
  if (choice?.type === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice?.type === 'tool' && choice.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } }
  }
  return undefined
}

export function buildGeminiRequestBody(
  params: ShimCreateParams,
  options: { model: string; baseUrl: string | undefined; effort: string | undefined },
): Record<string, unknown> {
  // applyStableStubs runs at the API boundary so the stable bytes are what
  // goes on the wire, as on the other shim paths.
  const messages = applyStableInputStubs(
    applyStableStubs(
      params.messages as Array<{
        role?: string
        message?: { role?: string; content?: unknown }
        content?: unknown
      }>,
    ),
  ) as Array<Record<string, unknown>>

  const system = convertSystemPrompt(params.system)
  const tools = convertTools(params.tools)
  const toolConfig = tools ? convertToolChoice(params.tool_choice) : undefined
  const thinkingConfig = geminiThinkingConfig({
    model: options.model,
    baseUrl: options.baseUrl,
    effort: options.effort,
    thinkingDisabled: (params.thinking as { type?: string } | undefined)?.type === 'disabled',
  })

  return {
    contents: convertMessagesToGeminiContents(messages, options.model),
    ...(system && { systemInstruction: { parts: [{ text: system }] } }),
    ...(tools && { tools }),
    ...(toolConfig && { toolConfig }),
    generationConfig: {
      ...(params.max_tokens > 0 && { maxOutputTokens: params.max_tokens }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.top_p !== undefined && { topP: params.top_p }),
      ...(thinkingConfig && { thinkingConfig }),
    },
  }
}
