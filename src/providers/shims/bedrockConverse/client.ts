/**
 * A Bedrock client for the models that only speak Converse (models.ts), in
 * the shape the native path calls: `beta.messages.create(params, options)`,
 * awaited or `.withResponse()`, a stream when `params.stream` is set and a
 * whole message otherwise.
 *
 * The AWS client is the one count_tokens already builds
 * (`createBedrockRuntimeClient`): the same region, endpoint override, proxy,
 * credentials and skip-auth. What the native path sends for Claude has no
 * Converse form and stays behind (request.ts). The client answers
 * `keepAlivePingParams` with null, since no cache point is written, and has
 * no `countTokens`, so the estimate is local. Client-side tool search comes
 * from the factory's wrapper (clientToolSearch/wrapClient.ts).
 */
import { createBedrockRuntimeClient } from 'src/providers/model/bedrock.js'
import { buildConverseInput } from 'src/providers/shims/bedrockConverse/request.js'
import { collectMessage, converseStreamToAnthropic } from 'src/providers/shims/bedrockConverse/stream.js'
import { converseApiError, isAbort } from 'src/providers/shims/bedrockConverse/errors.js'

type Event = Record<string, any>
type RuntimeClient = {
  send: (
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ stream?: AsyncIterable<Event>; $metadata?: { requestId?: string } }>
}
type CreateOptions = { signal?: AbortSignal; headers?: Record<string, string> } | undefined
type Result = { data: unknown; response: Response; request_id: string | undefined }
type CreateResult = Promise<unknown> & { withResponse: () => Promise<Result> }

/** The stream the native path iterates; `controller` is how it aborts one. */
class ConverseMessageStream {
  constructor(
    readonly controller: AbortController,
    private readonly events: AsyncGenerator<Record<string, unknown>>,
  ) {}

  [Symbol.asyncIterator]() {
    return this.events
  }
}

async function* rethrowingAsApiErrors(stream: AsyncIterable<Event> | undefined): AsyncGenerator<Event> {
  if (!stream) return
  try {
    yield* stream
  } catch (error) {
    throw isAbort(error) ? error : converseApiError(error as never)
  }
}

export function createConverseClient(): Record<string, unknown> {
  let runtime: Promise<RuntimeClient> | undefined

  function create(params: Record<string, any>, options?: CreateOptions): CreateResult {
    const answered = (async (): Promise<Result> => {
      const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime')
      const client = await (runtime ??= createBedrockRuntimeClient() as unknown as Promise<RuntimeClient>)
      const controller = new AbortController()
      const abortSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      let output: Awaited<ReturnType<RuntimeClient['send']>>
      try {
        output = await client.send(new ConverseStreamCommand(buildConverseInput(params)), { abortSignal })
      } catch (error) {
        throw isAbort(error) ? error : converseApiError(error as never)
      }
      const requestId = output.$metadata?.requestId
      const events = converseStreamToAnthropic(rethrowingAsApiErrors(output.stream), String(params.model))
      const data = params.stream
        ? new ConverseMessageStream(controller, events as AsyncGenerator<Record<string, unknown>>)
        : await collectMessage(events)
      return {
        data,
        response: new Response(null, { status: 200, headers: requestId ? { 'x-amzn-requestid': requestId } : {} }),
        request_id: requestId,
      }
    })()
    const out = answered.then(result => result.data) as CreateResult
    // A caller that only takes withResponse() never awaits `out` itself.
    out.catch(() => {})
    out.withResponse = () => answered
    return out
  }

  const messages = { create, keepAlivePingParams: () => null }
  return { beta: { messages }, messages }
}
