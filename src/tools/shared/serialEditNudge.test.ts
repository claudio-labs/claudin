import { describe, expect, test } from 'bun:test'
import {
  detectSerialEditStreak,
  renderSerialEditNudge,
  SERIAL_EDIT_MAX_SCAN,
  SERIAL_EDIT_THRESHOLD,
  SERIAL_EDIT_WINDOW,
} from './serialEditNudge.js'

type Block = { type: string; name?: string; input?: unknown; text?: string }

function assistant(...content: Block[]): unknown {
  return { type: 'assistant', message: { role: 'assistant', content } }
}

function user(text: string): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}

function patchInput(...paths: string[]): { patchText: string } {
  const body = paths
    .map(p => `*** Update File: ${p}\n@@ anchor\n-a\n+b`)
    .join('\n')
  return { patchText: `*** Begin Patch\n${body}\n*** End Patch` }
}

function patch(...paths: string[]): Block {
  return { type: 'tool_use', name: 'apply_patch', input: patchInput(...paths) }
}

function edit(path: string): Block {
  return { type: 'tool_use', name: 'Edit', input: { file_path: path } }
}

function write(path: string): Block {
  return { type: 'tool_use', name: 'Write', input: { file_path: path } }
}

function read(path: string): Block {
  return { type: 'tool_use', name: 'Read', input: { file_path: path } }
}

function bash(): Block {
  return { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }
}

describe('SERIAL_EDIT_THRESHOLD', () => {
  test('is 3', () => {
    // Pinned as a literal on purpose: the streak tests below compare against
    // the constant, so they would follow it silently if it changed.
    expect(SERIAL_EDIT_THRESHOLD).toBe(3)
  })
})

describe('detectSerialEditStreak — prior turns', () => {
  test('counts three consecutive single-file patches', () => {
    const messages = [
      user('go'),
      assistant(patch('a.ts')),
      assistant(patch('b.ts')),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('stays below the threshold at two', () => {
    const messages = [assistant(patch('a.ts')), assistant(patch('b.ts'))]
    expect(detectSerialEditStreak(messages)).toBe(2)
  })

  test('a batched newest turn scores zero', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(patch('b.ts')),
      assistant(patch('c.ts', 'd.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(0)
  })

  test('an older batched turn stops the walk without erasing the streak', () => {
    const messages = [
      assistant(patch('a.ts', 'b.ts')),
      assistant(patch('c.ts')),
      assistant(patch('d.ts')),
      assistant(patch('e.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('repeated edits to the same file are iteration, not the pattern', () => {
    const messages = [
      assistant(edit('a.ts')),
      assistant(edit('a.ts')),
      assistant(edit('a.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(1)
  })

  test('interleaved discovery turns are transparent', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(read('b.ts')),
      assistant(patch('b.ts')),
      assistant({ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('a TodoWrite turn between edits is transparent', () => {
    // The most common Claude turn shape. Treating it as a break made the
    // detector blind to the sequence it exists to catch.
    const messages = [
      assistant(patch('a.ts')),
      assistant({ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }),
      assistant(patch('b.ts')),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('a Bash turn between edits breaks the streak', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(bash()),
      assistant(patch('b.ts')),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(2)
  })

  test('an edit sharing its turn with a non-discovery tool breaks the streak', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(patch('b.ts')),
      assistant(patch('c.ts'), bash()),
    ]
    expect(detectSerialEditStreak(messages)).toBe(0)
  })

  test('Edit and Write count alongside apply_patch', () => {
    const messages = [
      assistant(edit('a.ts')),
      assistant(write('b.ts')),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('text-only turns are transparent', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant({ type: 'text', text: 'now the next one' }),
      assistant(patch('b.ts')),
      assistant(patch('c.ts')),
    ]
    expect(detectSerialEditStreak(messages)).toBe(3)
  })

  test('the window bounds the assistant turns considered', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(read('b.ts')),
      assistant(patch('b.ts')),
      assistant(read('c.ts')),
      assistant(patch('c.ts')),
    ]
    // Newest first: patch(c) [1], read [2], patch(b) [3] — the walk stops at
    // three scanned assistant messages, so patch(a) is never reached.
    expect(detectSerialEditStreak(messages, { window: 3 })).toBe(2)
    expect(detectSerialEditStreak(messages, { window: SERIAL_EDIT_WINDOW })).toBe(3)
  })

  test('maxScan bounds the walk over non-assistant messages', () => {
    // The window counts assistant turns only, so without a separate cap a long
    // tail of tool-result messages makes this O(transcript) on the render
    // thread. The three edits sit behind that tail and must not be reached.
    const messages = [
      assistant(patch('a.ts')),
      assistant(patch('b.ts')),
      assistant(patch('c.ts')),
      ...Array.from({ length: 30 }, (_, i) => user(`result ${i}`)),
    ]
    expect(detectSerialEditStreak(messages, { maxScan: 10 })).toBe(0)
    // The default cap is wide enough to see past a realistic tail…
    expect(
      detectSerialEditStreak(messages, { maxScan: SERIAL_EDIT_MAX_SCAN }),
    ).toBe(3)
    // …and SERIAL_EDIT_MAX_SCAN is the ceiling, so a longer tail than that
    // hides the streak. That is the deliberate trade: bounded work on the
    // render thread beats catching every case in a pathological transcript.
    expect(SERIAL_EDIT_MAX_SCAN).toBe(SERIAL_EDIT_WINDOW * 4)
  })

  test('an unparseable patch stops the walk rather than guessing', () => {
    const messages = [
      assistant(patch('a.ts')),
      assistant(patch('b.ts')),
      assistant({
        type: 'tool_use',
        name: 'apply_patch',
        input: { patchText: 'not an envelope' },
      }),
    ]
    expect(detectSerialEditStreak(messages)).toBe(0)
  })

  test('user turns never count', () => {
    expect(detectSerialEditStreak([user('a'), user('b'), user('c')])).toBe(0)
  })

  test('an empty transcript scores zero', () => {
    expect(detectSerialEditStreak([])).toBe(0)
  })
})

describe('detectSerialEditStreak — the current call', () => {
  // In production the call being answered is NOT in `messages` (query.ts
  // freezes that array before the turn streams), so it is passed separately.
  const priorSingles = [
    assistant(patch('a.ts')),
    assistant(patch('b.ts')),
    assistant(patch('c.ts')),
  ]

  test('a multi-file current patch scores zero despite three single-file priors', () => {
    // The whole point: without this the instrument scolds the exact behavior
    // it is asking for.
    expect(
      detectSerialEditStreak(priorSingles, {
        currentCall: {
          name: 'apply_patch',
          input: patchInput('d.ts', 'e.ts'),
        },
      }),
    ).toBe(0)
  })

  test('a single-file current patch is the newest turn of the streak', () => {
    expect(
      detectSerialEditStreak([assistant(patch('a.ts')), assistant(patch('b.ts'))], {
        currentCall: { name: 'apply_patch', input: patchInput('c.ts') },
      }),
    ).toBe(SERIAL_EDIT_THRESHOLD)
  })

  test('a current call on the same file as the last turn does not double-count', () => {
    expect(
      detectSerialEditStreak([assistant(patch('a.ts')), assistant(patch('b.ts'))], {
        currentCall: { name: 'apply_patch', input: patchInput('b.ts') },
      }),
    ).toBe(2)
  })

  test('a non-edit current call scores zero', () => {
    expect(
      detectSerialEditStreak(priorSingles, {
        currentCall: { name: 'Bash', input: { command: 'ls' } },
      }),
    ).toBe(0)
  })

  test('a current call whose target cannot be resolved scores zero', () => {
    expect(
      detectSerialEditStreak(priorSingles, {
        currentCall: { name: 'apply_patch', input: { patchText: 'garbage' } },
      }),
    ).toBe(0)
  })

  test('an Edit current call counts like a patch', () => {
    expect(
      detectSerialEditStreak([assistant(patch('a.ts')), assistant(patch('b.ts'))], {
        currentCall: { name: 'Edit', input: { file_path: 'c.ts' } },
      }),
    ).toBe(3)
  })
})

describe('renderSerialEditNudge', () => {
  test('names the count and the tool that fixes it', () => {
    const rendered = renderSerialEditNudge(3)
    expect(rendered).toContain('3 single-file edits in a row')
    expect(rendered).toContain('apply_patch')
    expect(rendered).toContain('<system-reminder>')
  })
})
