/**
 * The response half of client-side tool search: a call to CallTool carries the
 * real tool in its arguments, so it comes back as a `tool_use` of that tool.
 *
 * In a stream the name is only known once the call's arguments are whole, so
 * a CallTool block is held from its start to its stop, and every event after
 * its start waits behind it: the blocks keep the order the wire gave them.
 * Arguments that name no tool keep the CallTool name, so the agent loop
 * reports an unknown tool to the model instead of running a guess.
 */
import { CALL_TOOL_NAME, unwrapGatewayCall } from 'src/providers/shims/clientToolSearch/callTool.js'

type StreamEvent = {
  type: string
  index?: number
  content_block?: { type?: string; name?: string; id?: string; [key: string]: unknown }
  delta?: { type?: string; partial_json?: string; [key: string]: unknown }
  [key: string]: unknown
}

type Held = { index: number; start: StreamEvent; json: string; done: boolean; events: StreamEvent[] }
type Slot = { event: StreamEvent } | { held: Held }

function unwrappedEvents(held: Held): StreamEvent[] {
  const call = unwrapGatewayCall(held.json)
  return [
    {
      ...held.start,
      content_block: { ...held.start.content_block, name: call?.name ?? CALL_TOOL_NAME, input: {} },
    },
    {
      type: 'content_block_delta',
      index: held.index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call?.input ?? {}) },
    },
  ]
}

export async function* gatewayEvents<E>(events: AsyncIterable<E>): AsyncGenerator<E> {
  const queue: Slot[] = []
  const open = new Map<number, Held>()

  function* drain(): Generator<StreamEvent> {
    while (queue.length > 0) {
      const head = queue[0]!
      if ('held' in head) {
        if (!head.held.done) return
        yield* head.held.events
      } else {
        yield head.event
      }
      queue.shift()
    }
  }

  for await (const raw of events) {
    const event = raw as unknown as StreamEvent
    const index = event.index
    if (
      event.type === 'content_block_start' &&
      event.content_block?.type === 'tool_use' &&
      event.content_block.name === CALL_TOOL_NAME &&
      typeof index === 'number'
    ) {
      const held: Held = { index, start: event, json: '', done: false, events: [] }
      open.set(index, held)
      queue.push({ held })
      continue
    }
    const held = typeof index === 'number' ? open.get(index) : undefined
    if (held && event.type === 'content_block_delta') {
      if (event.delta?.type === 'input_json_delta') held.json += event.delta.partial_json ?? ''
      continue
    }
    if (held && event.type === 'content_block_stop') {
      open.delete(held.index)
      held.events = unwrappedEvents(held)
      held.done = true
      queue.push({ event })
      yield* drain() as Generator<E>
      continue
    }
    if (queue.length === 0) {
      yield raw
      continue
    }
    queue.push({ event })
  }
  // A stream cut before a held call stopped: send what was held, unwrapped.
  for (const held of open.values()) {
    held.events = unwrappedEvents(held)
    held.done = true
  }
  yield* drain() as Generator<E>
}

/** A whole (non-streamed) message with its gateway calls unwrapped. */
export function gatewayMessage<M>(message: M): M {
  const content = (message as { content?: unknown })?.content
  if (!Array.isArray(content)) return message
  let changed = false
  const next = content.map((block: { type?: string; name?: string; input?: unknown }) => {
    if (block?.type !== 'tool_use' || block.name !== CALL_TOOL_NAME) return block
    changed = true
    const call = unwrapGatewayCall(typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}))
    return { ...block, name: call?.name ?? CALL_TOOL_NAME, input: call?.input ?? {} }
  })
  return changed ? { ...message, content: next } : message
}
