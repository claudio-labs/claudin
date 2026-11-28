/**
 * A Bedrock client for the models that only speak Converse (models.ts), in
 * the shape the native path calls: `beta.messages.create(params, options)`,
 * awaited or `.withResponse()`, a stream when `params.stream` is set and a
 * whole message otherwise.
 *
 * The AWS client is the one count_tokens already builds
 * (`createBedrockRuntimeClient`): the profile's region, the endpoint override,
 * proxy, credentials and skip-auth, on HTTP/1.1 like AnthropicBedrock's fetch
 * (its HTTP/2 default hangs on a plain-HTTP endpoint). What the native path
 * sends for Claude has no Converse form and stays behind (request.ts). The
 * client answers `keepAlivePingParams` with null, since no cache point is
 * written, and has no `countTokens`, so the estimate is local. Client-side
 * tool search comes from the factory's wrapper (clientToolSearch/wrapClient.ts).
 *
 * An abort ends the stream at once as the SDK's own APIUserAbortError: the AWS
 * SDK keeps waiting on a stalled socket under Bun, and under Node throws a
 * plain `Error: aborted` that reads as a failure.
 */
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { createBedrockRuntimeClient } from 'src/providers/model/bedrock.js'
import { buildConverseInput } from 'src/providers/shims/bedrockConverse/request.js'
import {
  collectMessage,
  converseStreamToAnthropic,
  type ConverseEvent,
} from 'src/providers/shims/bedrockConverse/stream.js'
import { converseApiError, isAbort } from 'src/providers/shims/bedrockConverse/errors.js'

type RuntimeClient = {
  send: (
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ stream?: AsyncIterable<ConverseEvent>; $metadata?: { requestId?: string } }>
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

function failure(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return new APIUserAbortError()
  return isAbort(error) ? error : converseApiError(error as never)
}

/** The SDK's events, ended by `signal` even while a frame is pending, with its errors as API errors. */
async function* abortable(stream: AsyncIterable<ConverseEvent> | undefined, signal: AbortSignal): AsyncGenerator<ConverseEvent> {
  if (!stream) return
  const iterator = stream[Symbol.asyncIterator]()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new APIUserAbortError())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) return
      yield next.value
    }
  } catch (error) {
    throw failure(error, signal)
  } finally {
    signal.removeEventListener('abort', onAbort)
    void iterator.return?.()?.catch(() => {})
  }
}

export function createConverseClient(options: { region?: string } = {}): Record<string, unknown> {
  let runtime: Promise<RuntimeClient> | undefined

  function create(params: Record<string, unknown>, requestOptions?: CreateOptions): CreateResult {
    const answered = (async (): Promise<Result> => {
      const { ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime')
      const client = await (runtime ??= createBedrockRuntimeClient({
        http1: true,
        region: options.region,
      }) as unknown as Promise<RuntimeClient>)
      const controller = new AbortController()
      const signal = requestOptions?.signal ? AbortSignal.any([requestOptions.signal, controller.signal]) : controller.signal
      let output: Awaited<ReturnType<RuntimeClient['send']>>
      try {
        output = await client.send(new ConverseStreamCommand(buildConverseInput(params)), { abortSignal: signal })
      } catch (error) {
        throw failure(error, signal)
      }
      const requestId = output.$metadata?.requestId
      const events = converseStreamToAnthropic(abortable(output.stream, signal), String(params.model))
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
