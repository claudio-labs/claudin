import { afterEach, describe, expect, test } from 'bun:test'

import {
  isLagMarkerEnabled,
  KEY_EDGE_CHARS,
  LAG_MARKER_TTL_MS,
  pickLagMarker,
  placeLagMarker,
  prefixKeys,
  rememberBreakpoint,
  type RememberedPrefixes,
} from 'src/permissions/yoloClassifier/lagMarker.js'

const T0 = 1_000_000

describe('prefixKeys', () => {
  test('one key per prefix, and an append leaves the earlier ones as they were', () => {
    const before = prefixKeys(['a', 'bb', 'ccc'])
    const after = prefixKeys(['a', 'bb', 'ccc', 'dddd'])

    expect(before).toHaveLength(3)
    expect(after.slice(0, 3)).toEqual(before)
    expect(new Set(after).size).toBe(4)
  })

  test('where a block ends is part of the key', () => {
    expect(prefixKeys(['ab', 'c'])[1]).not.toBe(prefixKeys(['a', 'bc'])[1])
    expect(prefixKeys(['ab'])[0]).not.toBe(prefixKeys(['a', 'b'])[1])
  })

  test('a change anywhere before it changes a key', () => {
    expect(prefixKeys(['x', 'b', 'c'])[2]).not.toBe(prefixKeys(['a', 'b', 'c'])[2])
  })

  // A key is a fingerprint. Walking every char of an 800k-char transcript on
  // each classifier call took 8.6 ms under Bun; a long block is told apart by
  // its length and its two ends instead.
  test('a long block is keyed by its length and both ends', () => {
    const long = (head: string, middle: string, tail: string, fill = 400): string =>
      `${head.padEnd(KEY_EDGE_CHARS, 'h')}${middle.padEnd(fill, 'm')}${tail.padStart(KEY_EDGE_CHARS, 't')}`
    const base = prefixKeys([long('Write a', 'x', 'end')])[0]

    expect(prefixKeys([long('Write b', 'x', 'end')])[0]).not.toBe(base)
    expect(prefixKeys([long('Write a', 'x', 'END')])[0]).not.toBe(base)
    expect(prefixKeys([long('Write a', 'x', 'end', 401)])[0]).not.toBe(base)
    // The limit, on purpose: the same length and ends with another middle.
    expect(prefixKeys([long('Write a', 'y', 'end')])[0]).toBe(base)
  })

  test('a block of up to two edges is keyed by every char', () => {
    const block = 'a'.repeat(2 * KEY_EDGE_CHARS)
    const changed = `${'a'.repeat(KEY_EDGE_CHARS)}b${'a'.repeat(KEY_EDGE_CHARS - 1)}`
    expect(prefixKeys([changed])[0]).not.toBe(prefixKeys([block])[0])
  })
})

describe('pickLagMarker', () => {
  test('nothing remembered, nothing to mark', () => {
    expect(pickLagMarker(prefixKeys(['a', 'b']), new Map(), T0)).toBeNull()
  })

  test('marks the end of the longest remembered prefix', () => {
    const keys = prefixKeys(['a', 'b', 'c', 'd'])
    const remembered: RememberedPrefixes = new Map([
      [keys[0]!, T0],
      [keys[2]!, T0],
    ])

    expect(pickLagMarker(keys, remembered, T0 + 1)).toBe(2)
  })

  test('a breakpoint older than the TTL is not marked', () => {
    const keys = prefixKeys(['a', 'b'])
    const remembered: RememberedPrefixes = new Map([[keys[1]!, T0]])

    expect(pickLagMarker(keys, remembered, T0 + LAG_MARKER_TTL_MS)).toBe(1)
    expect(pickLagMarker(keys, remembered, T0 + LAG_MARKER_TTL_MS + 1)).toBeNull()
  })
})

describe('rememberBreakpoint', () => {
  test('drops what the TTL has passed', () => {
    const remembered: RememberedPrefixes = new Map()
    rememberBreakpoint(remembered, 'old', T0)
    rememberBreakpoint(remembered, 'new', T0 + LAG_MARKER_TTL_MS + 1)

    expect([...remembered.keys()]).toEqual(['new'])
  })

  test('keeps the 64 most recent, and a key remembered again counts as recent', () => {
    const remembered: RememberedPrefixes = new Map()
    for (let i = 0; i < 64; i++) rememberBreakpoint(remembered, `k${i}`, T0 + i)
    rememberBreakpoint(remembered, 'k0', T0 + 100)
    rememberBreakpoint(remembered, 'k64', T0 + 101)

    expect(remembered.size).toBe(64)
    expect(remembered.has('k0')).toBe(true)
    expect(remembered.has('k1')).toBe(false)
  })
})

describe('placeLagMarker', () => {
  test('the first call marks nothing; the next marks where it ended', () => {
    const remembered: RememberedPrefixes = new Map()
    expect(placeLagMarker(['User: go\n'], 'Bash one\n', T0, remembered)).toBeNull()

    // The judged call is now history, and 22 unjudged ones followed it.
    const grown = ['User: go\n', 'Bash one\n', ...Array.from({ length: 22 }, (_, i) => `Read f${i}\n`)]
    expect(placeLagMarker(grown, 'Bash two\n', T0 + 1, remembered)).toBe(1)
  })

  test('a call whose action follows at once marks the block before it', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['User: go\n'], 'Bash one\n', T0, remembered)

    expect(placeLagMarker(['User: go\n', 'Bash one\n'], 'Bash two\n', T0 + 1, remembered)).toBe(1)
  })

  test('the same call again marks nothing: what it remembers is its action, never a transcript block', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['User: go\n'], 'Bash one\n', T0, remembered)

    expect(placeLagMarker(['User: go\n'], 'Bash one\n', T0 + 1, remembered)).toBeNull()
  })

  test('a transcript whose front moved shares no prefix, so nothing is marked', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['User: go\n', 'Read a\n'], 'Bash one\n', T0, remembered)

    expect(placeLagMarker(['Read a\n', 'Bash one\n', 'Read b\n'], 'Bash two\n', T0 + 1, remembered)).toBeNull()
  })

  test('an action serialized differently in history is not mistaken for the prefix', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['User: go\n'], 'Write {"file_path":"~/a"}\n', T0, remembered)

    expect(
      placeLagMarker(['User: go\n', 'Write {"file_path":"/home/u/a"}\n'], 'Bash two\n', T0 + 1, remembered),
    ).toBeNull()
  })

  test('threads share the map and never each other’s marker', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['User: main\n'], 'Bash m1\n', T0, remembered)
    placeLagMarker(['User: child\n'], 'Bash c1\n', T0 + 1, remembered)

    expect(placeLagMarker(['User: main\n', 'Bash m1\n', 'Read x\n'], 'Bash m2\n', T0 + 2, remembered)).toBe(1)
    expect(placeLagMarker(['User: child\n', 'Bash c1\n'], 'Bash c2\n', T0 + 3, remembered)).toBe(1)
  })

  test('a marked prefix stays remembered for the call after', () => {
    const remembered: RememberedPrefixes = new Map()
    placeLagMarker(['a\n'], 'b\n', T0, remembered)
    // Marked at T0 + 50 min: the read refreshes it, so 50 minutes later it is still worth marking.
    const later = T0 + 50 * 60 * 1000
    expect(placeLagMarker(['a\n', 'b\n', 'c\n'], 'x\n', later, remembered)).toBe(1)
    const keys = prefixKeys(['a\n', 'b\n'])
    expect(remembered.get(keys[1]!)).toBe(later)
  })
})

describe('isLagMarkerEnabled', () => {
  const saved = process.env.CLAUDIN_CLASSIFIER_LAG_MARKER

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDIN_CLASSIFIER_LAG_MARKER
    else process.env.CLAUDIN_CLASSIFIER_LAG_MARKER = saved
  })

  test('off unless the env turns it on', () => {
    delete process.env.CLAUDIN_CLASSIFIER_LAG_MARKER
    expect(isLagMarkerEnabled()).toBe(false)
    process.env.CLAUDIN_CLASSIFIER_LAG_MARKER = '1'
    expect(isLagMarkerEnabled()).toBe(true)
  })
})
