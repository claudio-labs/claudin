import { describe, expect, test } from 'bun:test'
import { SEMANTIC_NEUTRAL_COMMANDS, walkCommandSegments } from 'src/platform/bash/segments.js'

/** Compact view of the walk, so the assertions read like the command. */
function shape(command: string): Array<[string, string | null]> {
  const walked = walkCommandSegments(command)
  if (!walked) throw new Error(`expected a walk for: ${command}`)
  return walked.segments.map(s => [s.name, s.joinedBy])
}

describe('walkCommandSegments — segmentation', () => {
  test('a single command is one segment joined by nothing', () => {
    expect(shape('cat foo.ts')).toEqual([['cat', null]])
  })

  test('records the operator that joined each segment', () => {
    expect(shape('grep -n foo f.ts | sed -n 2p && echo done ; ls')).toEqual([
      ['grep', null],
      ['sed', '|'],
      ['echo', '&&'],
      ['ls', ';'],
    ])
  })

  test('|| is distinguished from |', () => {
    expect(shape('cat a.ts || echo missing')).toEqual([
      ['cat', null],
      ['echo', '||'],
    ])
  })

  test('keeps the segment text with its quotes, so a quoted pattern survives', () => {
    // The real-world case this walk exists for: an alternation whose `|` is
    // inside quotes must NOT split the command. If it did, the redirect would
    // see a bogus segment named `...`.
    const walked = walkCommandSegments('grep -rn "a\\|b" src --include=*.ts')
    expect(walked?.segments).toHaveLength(1)
    expect(walked?.segments[0]?.text).toContain('"a\\|b"')
  })
})

describe('walkCommandSegments — neutral commands', () => {
  for (const name of SEMANTIC_NEUTRAL_COMMANDS) {
    test(`${name} is neutral`, () => {
      const walked = walkCommandSegments(`${name} hi`)
      expect(walked?.segments[0]?.isNeutral).toBe(true)
    })
  }

  test('a real command is not neutral', () => {
    const walked = walkCommandSegments('cat foo.ts')
    expect(walked?.segments[0]?.isNeutral).toBe(false)
  })
})

describe('walkCommandSegments — output redirection', () => {
  test('> is flagged and its target is not a segment', () => {
    const walked = walkCommandSegments('grep -rn foo src > /tmp/out')
    expect(walked?.hasOutputRedirection).toBe(true)
    expect(walked?.segments.map(s => s.name)).toEqual(['grep'])
  })

  test('>> is flagged too', () => {
    const walked = walkCommandSegments('cat a.ts >> /tmp/out')
    expect(walked?.hasOutputRedirection).toBe(true)
    expect(walked?.segments.map(s => s.name)).toEqual(['cat'])
  })

  test('>& is flagged — fd duplication is read conservatively', () => {
    const walked = walkCommandSegments('cat a.ts 2>&1')
    expect(walked?.hasOutputRedirection).toBe(true)
  })

  test('no redirection leaves the flag off', () => {
    expect(walkCommandSegments('cat a.ts')?.hasOutputRedirection).toBe(false)
  })

  test('a redirect target is dropped even mid-chain', () => {
    const walked = walkCommandSegments('cat a.ts > /tmp/out && cat b.ts')
    expect(walked?.segments.map(s => s.name)).toEqual(['cat', 'cat'])
  })
})

describe('walkCommandSegments — 2>/dev/null discards stderr', () => {
  test('it is not flagged, and the fd does not survive as an argument', () => {
    const walked = walkCommandSegments('grep -rn foo src 2>/dev/null')
    expect(walked?.hasOutputRedirection).toBe(false)
    expect(walked?.segments.map(s => s.text)).toEqual(['grep -rn foo src'])
  })

  test('mid-pipeline, the segments either side survive', () => {
    const walked = walkCommandSegments('grep -n foo a.ts 2>/dev/null | head -5')
    expect(walked?.hasOutputRedirection).toBe(false)
    expect(walked?.segments.map(s => s.text)).toEqual([
      'grep -n foo a.ts',
      'head -5',
    ])
  })

  // The fd rides in glued to the previous segment, so the walk cannot tell
  // these apart from the token stream alone — the raw text is what does it.
  test('`cat f 2 > /dev/null` is still flagged: that is stdout going nowhere', () => {
    const walked = walkCommandSegments('cat a.ts 2 > /dev/null')
    expect(walked?.hasOutputRedirection).toBe(true)
    expect(walked?.segments.map(s => s.text)).toEqual(['cat a.ts 2'])
  })

  test('2>&1 keeps the flag — stderr is merged INTO stdout, not dropped', () => {
    expect(
      walkCommandSegments('grep -rn foo src 2>&1')?.hasOutputRedirection,
    ).toBe(true)
  })

  test('2>>/dev/null is a discard too — appending to the void is still the void', () => {
    const walked = walkCommandSegments('grep -rn foo src 2>>/dev/null')
    expect(walked?.hasOutputRedirection).toBe(false)
    expect(walked?.segments.map(s => s.text)).toEqual(['grep -rn foo src'])
  })

  // The adjacency test reads the whole command, so once ANY segment discards
  // stderr it stops being able to vouch for the others; the fd on the segment
  // itself is what does. Without that check the second redirection here reads
  // as a discard and the command looks like a plain read.
  test('stdout to /dev/null later in the same command is still flagged', () => {
    const walked = walkCommandSegments(
      'grep -n foo a.ts 2>/dev/null && cat b.ts > /dev/null',
    )
    expect(walked?.hasOutputRedirection).toBe(true)
    expect(walked?.segments.map(s => s.text)).toEqual([
      'grep -n foo a.ts',
      'cat b.ts',
    ])
  })

  test('2>err.log keeps the flag — it writes a file', () => {
    expect(
      walkCommandSegments('grep -rn foo src 2>err.log')?.hasOutputRedirection,
    ).toBe(true)
  })

  test('>/dev/null keeps the flag — that is the answer being thrown away', () => {
    expect(
      walkCommandSegments('grep -rn foo src >/dev/null')?.hasOutputRedirection,
    ).toBe(true)
  })

  test('a quoted 2>/dev/null is an argument, not a redirection', () => {
    const walked = walkCommandSegments('grep -n "2>/dev/null" a.ts')
    expect(walked?.hasOutputRedirection).toBe(false)
    expect(walked?.segments.map(s => s.name)).toEqual(['grep'])
  })
})

describe('walkCommandSegments — nothing to walk', () => {
  const NOTHING: Array<[string, string]> = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['&&', 'only an operator'],
    ['| ;', 'only operators'],
  ]
  for (const [command, why] of NOTHING) {
    test(`${JSON.stringify(command)} — ${why}`, () => {
      expect(walkCommandSegments(command)).toBeNull()
    })
  }
})
