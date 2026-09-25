import { expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { buildConversationChain } from 'src/sessions/resume/chain.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

// Parallel tool calls are written the way the live process appended them:
// completion order, one tool_result per message, each chained to its own
// one-block assistant. Results that complete together share a millisecond
// timestamp (a batch of Reads: seven results in 5 ms, 2026-09-23). Resume must
// rebuild the order the live process sent — a different order is a different
// prompt, and the cache misses from that block on.

const TS = '2026-09-23T06:04:13.243Z'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID

function entry(uuid: UUID, parentUuid: UUID | null, rest: Record<string, unknown>): TranscriptMessage {
  return { uuid, parentUuid, timestamp: TS, isSidechain: false, userType: 'external', cwd: '/repo', sessionId: 's', version: 't', ...rest } as unknown as TranscriptMessage
}
const toolUse = (uuid: UUID, parent: UUID, toolId: string) =>
  entry(uuid, parent, {
    type: 'assistant',
    message: { id: 'msg_batch', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: {} }] },
  })
const toolResult = (uuid: UUID, parent: UUID, toolId: string) =>
  entry(uuid, parent, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: toolId }] },
  })
// Hook output about one tool call. insertMessageChain parents it to whatever
// was written before it, like any other entry; only a tool_result jumps back
// to its own assistant.
const hookContext = (uuid: UUID, parent: UUID, toolId: string, hookEvent: 'PreToolUse' | 'PostToolUse', timestamp = TS) =>
  entry(uuid, parent, {
    type: 'attachment',
    timestamp,
    attachment: {
      type: 'hook_additional_context',
      content: [`${hookEvent} context for ${toolId}`],
      hookName: `${hookEvent}:Read`,
      toolUseID: toolId,
      hookEvent,
    },
  })
const prompt = () => entry(id(1), null, { type: 'user', message: { role: 'user', content: 'read the files' } })
const reply = (uuid: UUID, parent: UUID) =>
  entry(uuid, parent, {
    type: 'assistant',
    message: { id: 'msg_reply', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  })

function resumedOrder(written: TranscriptMessage[]): UUID[] {
  const messages = new Map(written.map(m => [m.uuid, m]))
  return buildConversationChain(messages, written.at(-1)!).map(m => m.uuid)
}

test('parallel tool results come back in write order, even when their timestamps tie', () => {
  const prompt = entry(id(1), null, { type: 'user', message: { role: 'user', content: 'read three files' } })
  const a = toolUse(id(2), id(1), 'A')
  const b = toolUse(id(3), id(2), 'B')
  const c = toolUse(id(4), id(3), 'C')
  // Completed C, A, B — the order they reached the model live.
  const trC = toolResult(id(5), id(4), 'C')
  const trA = toolResult(id(6), id(2), 'A')
  const trB = toolResult(id(7), id(3), 'B')
  const reply = entry(id(8), id(7), {
    type: 'assistant',
    message: { id: 'msg_reply', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  })
  const written = [prompt, a, b, c, trC, trA, trB, reply]
  const messages = new Map(written.map(m => [m.uuid, m]))

  const chain = buildConversationChain(messages, reply)

  const resultOrder = chain
    .flatMap(m => (m.type === 'user' && Array.isArray(m.message.content) ? [m.message.content] : []))
    .map(content => (content as Array<{ tool_use_id: string }>)[0]!.tool_use_id)
  expect(resultOrder).toEqual(['C', 'A', 'B'])
  expect(chain).toHaveLength(written.length)
})

// Everything a tool call writes besides its result: PreToolUse output lands
// between the tool_use and the result, PostToolUse output and the tool's own
// extra messages after it. Live, all of it is folded into the tool_result the
// model receives, so an entry the walk leaves behind changes that block's
// bytes on resume.

test('PreToolUse output between a tool_use and its result is not dropped', () => {
  // The result is re-parented to the assistant, so the hook entry written
  // before it is a dead-end sibling: the walk goes reply → result → assistant.
  const a = toolUse(id(2), id(1), 'A')
  const pre = hookContext(id(3), id(2), 'A', 'PreToolUse')
  const trA = toolResult(id(4), id(2), 'A')
  const written = [prompt(), a, pre, trA, reply(id(5), id(4))]

  expect(resumedOrder(written)).toEqual(written.map(m => m.uuid))
})

test('every parallel tool keeps its PostToolUse output, not only the last one written', () => {
  // Each tool's messages are written as one run, so A's hook output hangs off
  // A's result — which the walk only reaches through recovery.
  const a = toolUse(id(2), id(1), 'A')
  const b = toolUse(id(3), id(2), 'B')
  const trA = toolResult(id(4), id(2), 'A')
  const postA = hookContext(id(5), id(4), 'A', 'PostToolUse')
  const trB = toolResult(id(6), id(3), 'B')
  const postB = hookContext(id(7), id(6), 'B', 'PostToolUse')
  const written = [prompt(), a, b, trA, postA, trB, postB, reply(id(8), id(7))]

  expect(resumedOrder(written)).toEqual(written.map(m => m.uuid))
})

test('a recovered result brings the rest of its run, hook or not', () => {
  // A Read of an image or a PDF returns extra meta messages after its result
  // (readDispatch.ts newMessages); they carry no toolUseID, only a parent.
  const a = toolUse(id(2), id(1), 'A')
  const b = toolUse(id(3), id(2), 'B')
  const trA = toolResult(id(4), id(2), 'A')
  const postA = hookContext(id(5), id(4), 'A', 'PostToolUse')
  const extraA = entry(id(6), id(5), { type: 'user', isMeta: true, message: { role: 'user', content: 'page 1 of a.pdf' } })
  const trB = toolResult(id(7), id(3), 'B')
  const written = [prompt(), a, b, trA, postA, extraA, trB, reply(id(8), id(7))]

  expect(resumedOrder(written)).toEqual(written.map(m => m.uuid))
})

test('a sibling streamed after a result is recovered once, not twice', () => {
  // A build that ran tools while streaming wrote a fast call's result while
  // the model was still streaming the next tool_use, so that assistant block is both a
  // sibling (same message id) and a child of the result. Recovered twice, its
  // tool_use would reach the API twice — a 400.
  const a = toolUse(id(2), id(1), 'A')
  const b = toolUse(id(3), id(2), 'B')
  const trA = toolResult(id(4), id(2), 'A')
  const c = toolUse(id(5), id(4), 'C')
  const trC = toolResult(id(6), id(5), 'C')
  const trB = toolResult(id(7), id(3), 'B')
  const written = [prompt(), a, b, trA, c, trC, trB, reply(id(8), id(7))]

  const order = resumedOrder(written)
  expect(order).toHaveLength(written.length)
  expect(order.toSorted()).toEqual(written.map(m => m.uuid).toSorted())
})

test('hook output of parallel tools comes back in write order, not in creation order', () => {
  // B's PreToolUse hook ran before A's result existed, but B finished second,
  // so its run was written after A's — and write order is what went out live.
  const at = (ms: number) => new Date(Date.parse(TS) + ms).toISOString()
  const a = toolUse(id(2), id(1), 'A')
  const b = toolUse(id(3), id(2), 'B')
  const preA = hookContext(id(4), id(3), 'A', 'PreToolUse', at(1))
  const trA = toolResult(id(5), id(2), 'A')
  trA.timestamp = at(30)
  const preB = hookContext(id(6), id(5), 'B', 'PreToolUse', at(2))
  const trB = toolResult(id(7), id(3), 'B')
  trB.timestamp = at(40)
  const written = [prompt(), a, b, preA, trA, preB, trB, reply(id(8), id(7))]

  expect(resumedOrder(written)).toEqual(written.map(m => m.uuid))
})
