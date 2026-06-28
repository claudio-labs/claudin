import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
} from '../../utils/messages/constants.js'
import { detectRepeatedErrorLoop } from './loopDetector.js'

let counter = 0
const uid = () => `id-${counter++}`

function humanTurn(text = 'do the thing'): Message {
  return {
    type: 'user',
    uuid: uid(),
    isMeta: false,
    toolUseResult: undefined,
    message: { role: 'user', content: text },
  } as unknown as Message
}

function toolUse(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): Message {
  return {
    type: 'assistant',
    uuid: uid(),
    message: {
      role: 'assistant',
      id: uid(),
      content: calls.map(c => ({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    },
  } as unknown as Message
}

function toolResult(
  toolUseId: string,
  isError: boolean,
  content: string = isError ? 'boom' : 'ok',
): Message {
  return {
    type: 'user',
    uuid: uid(),
    isMeta: false,
    // toolUseResult defined => NOT treated as a human-turn boundary.
    toolUseResult: { stdout: content },
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content },
      ],
    },
  } as unknown as Message
}

/** Helper: N calls of the same Bash command, each producing the given result. */
function repeatedBash(
  command: string,
  n: number,
  isError: boolean,
): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    const id = uid()
    out.push(toolUse([{ id, name: 'Bash', input: { command } }]))
    out.push(toolResult(id, isError))
  }
  return out
}

describe('detectRepeatedErrorLoop', () => {
  test('3x identical failing Bash -> signal', () => {
    const human = humanTurn()
    const sig = detectRepeatedErrorLoop([
      human,
      ...repeatedBash('false', 3, true),
    ])
    expect(sig).not.toBeNull()
    expect(sig!.toolName).toBe('Bash')
    expect(sig!.repeatCount).toBe(3)
    expect(sig!.userTurnUuid).toBe(human.uuid)
    expect(typeof sig!.loopKey).toBe('string')
  })

  test('2x failing (below threshold) -> null', () => {
    expect(
      detectRepeatedErrorLoop([humanTurn(), ...repeatedBash('false', 2, true)]),
    ).toBeNull()
  })

  test('3x same input but all succeed -> null', () => {
    expect(
      detectRepeatedErrorLoop([humanTurn(), ...repeatedBash('true', 3, false)]),
    ).toBeNull()
  })

  test('3x same tool, different inputs -> null', () => {
    const human = humanTurn()
    const msgs: Message[] = [human]
    for (const cmd of ['a', 'b', 'c']) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: cmd } }]))
      msgs.push(toolResult(id, true))
    }
    expect(detectRepeatedErrorLoop(msgs)).toBeNull()
  })

  test('interleaved A(fail) B(ok) A(fail) A(fail) -> signal for A', () => {
    const human = humanTurn()
    const a1 = uid(),
      b1 = uid(),
      a2 = uid(),
      a3 = uid()
    const sig = detectRepeatedErrorLoop([
      human,
      toolUse([{ id: a1, name: 'Bash', input: { command: 'x' } }]),
      toolResult(a1, true),
      toolUse([{ id: b1, name: 'Read', input: { file_path: '/tmp/y' } }]),
      toolResult(b1, false),
      toolUse([{ id: a2, name: 'Bash', input: { command: 'x' } }]),
      toolResult(a2, true),
      toolUse([{ id: a3, name: 'Bash', input: { command: 'x' } }]),
      toolResult(a3, true),
    ])
    expect(sig).not.toBeNull()
    expect(sig!.toolName).toBe('Bash')
    expect(sig!.repeatCount).toBe(3)
  })

  test('canonical input: key order does not matter -> signal', () => {
    const human = humanTurn()
    const inputs = [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
      { a: 1, b: 2 },
    ]
    const msgs: Message[] = [human]
    for (const input of inputs) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input }]))
      msgs.push(toolResult(id, true))
    }
    const sig = detectRepeatedErrorLoop(msgs)
    expect(sig).not.toBeNull()
    expect(sig!.repeatCount).toBe(3)
  })

  test('interrupted calls do not count -> null', () => {
    const human = humanTurn()
    const msgs: Message[] = [human]
    for (let i = 0; i < 3; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: 'x' } }]))
      msgs.push(toolResult(id, true, INTERRUPT_MESSAGE_FOR_TOOL_USE))
    }
    expect(detectRepeatedErrorLoop(msgs)).toBeNull()
  })

  test('user-cancelled calls do not count -> null', () => {
    const msgs: Message[] = [humanTurn()]
    for (let i = 0; i < 3; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: 'x' } }]))
      msgs.push(toolResult(id, true, CANCEL_MESSAGE))
    }
    expect(detectRepeatedErrorLoop(msgs)).toBeNull()
  })

  test('user-denied calls do not count -> null', () => {
    const msgs: Message[] = [humanTurn()]
    for (let i = 0; i < 3; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: 'x' } }]))
      msgs.push(toolResult(id, true, REJECT_MESSAGE))
    }
    expect(detectRepeatedErrorLoop(msgs)).toBeNull()
  })

  test('array-content interrupt (text block) does not count -> null', () => {
    const msgs: Message[] = [humanTurn()]
    for (let i = 0; i < 3; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: 'x' } }]))
      msgs.push({
        type: 'user',
        uuid: uid(),
        isMeta: false,
        toolUseResult: { stdout: '' },
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              is_error: true,
              content: [
                { type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE },
              ],
            },
          ],
        },
      } as unknown as Message)
    }
    expect(detectRepeatedErrorLoop(msgs)).toBeNull()
  })

  test('parallel tool_use in one assistant message -> counted as 3', () => {
    const a = uid(),
      b = uid(),
      c = uid()
    const sig = detectRepeatedErrorLoop([
      humanTurn(),
      // Three identical failing calls issued in a single assistant message.
      toolUse([
        { id: a, name: 'Bash', input: { command: 'x' } },
        { id: b, name: 'Bash', input: { command: 'x' } },
        { id: c, name: 'Bash', input: { command: 'x' } },
      ]),
      toolResult(a, true),
      toolResult(b, true),
      toolResult(c, true),
    ])
    expect(sig).not.toBeNull()
    expect(sig!.repeatCount).toBe(3)
  })

  test('two qualifying keys -> the loudest (higher count) wins', () => {
    const msgs: Message[] = [humanTurn()]
    // key X errors 3×, key Y errors 4× — Y should be reported.
    for (let i = 0; i < 3; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Bash', input: { command: 'X' } }]))
      msgs.push(toolResult(id, true))
    }
    for (let i = 0; i < 4; i++) {
      const id = uid()
      msgs.push(toolUse([{ id, name: 'Grep', input: { pattern: 'Y' } }]))
      msgs.push(toolResult(id, true))
    }
    const sig = detectRepeatedErrorLoop(msgs)
    expect(sig).not.toBeNull()
    expect(sig!.toolName).toBe('Grep')
    expect(sig!.repeatCount).toBe(4)
  })

  test('recovery guard: 3 fails then a later success -> null', () => {
    const human = humanTurn()
    const sig = detectRepeatedErrorLoop([
      human,
      ...repeatedBash('flaky', 3, true),
      // 4th call of the same key succeeds — agent un-stuck itself.
      ...repeatedBash('flaky', 1, false),
    ])
    expect(sig).toBeNull()
  })

  test('loop in a PRIOR human turn is out of scope -> null', () => {
    const sig = detectRepeatedErrorLoop([
      humanTurn('first task'),
      ...repeatedBash('false', 3, true),
      // New human turn resets the window; nothing failing after it.
      humanTurn('second task'),
      ...repeatedBash('true', 1, false),
    ])
    expect(sig).toBeNull()
  })

  test('empty / no messages -> null', () => {
    expect(detectRepeatedErrorLoop([])).toBeNull()
  })
})
