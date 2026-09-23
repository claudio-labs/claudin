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
