/**
 * Characterization of how a resume turns the entries of a transcript into one
 * conversation, pinned before the clean-base rewrite of `sessions/resume`:
 * picking the latest entry, walking `parentUuid` from a tip back to the root,
 * bringing back the tool results and hook output a single-parent walk loses,
 * splicing a preserved segment back in after a compaction, and replaying snip
 * removals. Everything is reached through the session-storage barrel, on
 * in-memory transcript maps laid out the way the CLI writes them.
 */
import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'

import {
  asMap,
  attachment,
  compactBoundary,
  hookOutput,
  id,
  type Line,
  notice,
  prompt,
  reply,
  second,
  toolResult,
  toolUse,
  uuids,
} from 'src/sessions/__testutils__/resumeTranscripts.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildConversationChain,
  findLatestMessage,
  recoverOrphanedParallelToolResults,
} from 'src/sessions/sessionStorage.js'
import type { TranscriptMessage } from 'src/shared/types/logs.js'

const chainFrom = (lines: Line[], tip: number) => {
  const map = asMap(lines)
  return uuids(buildConversationChain(map, map.get(id(tip))!))
}
const ids = (...numbers: number[]) => numbers.map(id)

// --- the latest entry ---------------------------------------------------------

describe('findLatestMessage', () => {
  type Stamped = { uuid: string; timestamp: string; kind: string }
  const pool: Stamped[] = [
    { uuid: 'early', timestamp: second(1), kind: 'note' },
    { uuid: 'newest', timestamp: second(9), kind: 'mark' },
    { uuid: 'middle', timestamp: second(4), kind: 'note' },
    { uuid: 'garbled', timestamp: 'yesterday-ish', kind: 'note' },
    { uuid: 'blank', timestamp: '', kind: 'odd' },
  ]
  const cases: Array<{ want: string; accept: (s: Stamped) => boolean; expected: string | undefined }> = [
    { want: 'any entry', accept: () => true, expected: 'newest' },
    { want: 'notes only', accept: s => s.kind === 'note', expected: 'middle' },
    { want: 'a kind nobody has', accept: s => s.kind === 'none', expected: undefined },
    { want: 'only entries without a usable time', accept: s => s.kind === 'odd' || s.uuid === 'garbled', expected: undefined },
  ]
  for (const c of cases) {
    test(`${c.want} → ${c.expected ?? 'nothing'}`, () => {
      expect(findLatestMessage(pool, c.accept)?.uuid).toBe(c.expected)
      expect(findLatestMessage([...pool].reverse(), c.accept)?.uuid).toBe(c.expected)
    })
  }

  test('takes any iterable, a generator or a map’s values included, and an empty one gives nothing', () => {
    function* produce() {
      yield* pool
    }
    expect(findLatestMessage(produce(), s => s.kind === 'note')?.uuid).toBe('middle')
    expect(findLatestMessage(new Map(pool.map(s => [s.uuid, s])).values(), () => true)?.uuid).toBe('newest')
    expect(findLatestMessage([], () => true)).toBeUndefined()
  })
})

// --- walking the chain --------------------------------------------------------

describe('buildConversationChain — the walk from a tip to the root', () => {
  const tree = [
    prompt(id(1), 'start'),
    reply(id(2), 'first answer', { parent: id(1) }),
    prompt(id(3), 'go on', { parent: id(2) }),
    reply(id(4), 'second answer', { parent: id(3) }),
    prompt(id(5), 'no, try again', { parent: id(2) }),
    reply(id(6), 'other answer', { parent: id(5) }),
  ]
  const cases = [
    { name: 'the original branch', lines: tree, tip: 4, expected: ids(1, 2, 3, 4) },
    { name: 'the rewound branch', lines: tree, tip: 6, expected: ids(1, 2, 5, 6) },
    { name: 'a tip that is the root', lines: tree, tip: 1, expected: ids(1) },
    {
      name: 'a parent missing from the transcript starts the chain after the gap',
      lines: [...tree.slice(0, 2), prompt(id(3), 'go on', { parent: id(99) }), tree[3]!],
      tip: 4,
      expected: ids(3, 4),
    },
    {
      name: 'a parent cycle stops at the first entry seen twice',
      lines: [
        prompt(id(1), 'a', { parent: id(3) }),
        prompt(id(2), 'b', { parent: id(1) }),
        prompt(id(3), 'c', { parent: id(2) }),
      ],
      tip: 3,
      expected: ids(1, 2, 3),
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(chainFrom(c.lines, c.tip)).toEqual(c.expected)
    })
  }

  test('the entries come back as they are in the map, not copies', () => {
    const map = asMap(tree)
    const chain = buildConversationChain(map, map.get(id(4))!)
    expect(chain[0]).toBe(map.get(id(1))!)
    expect(chain.at(-1)).toBe(map.get(id(4))!)
  })
})

describe('buildConversationChain — what a single-parent walk would lose', () => {
  // One model response streamed as one assistant entry per tool call: the
  // entries share the response id, and each tool result points back at its own
  // assistant entry.
  test('parallel calls: the result the walk skipped comes back after the last block of the response', () => {
    const lines = [
      prompt(id(1), 'read both'),
      reply(id(2), [toolUse('call-a')], { parent: id(1), responseId: 'resp-x' }),
      reply(id(3), [toolUse('call-b')], { parent: id(2), responseId: 'resp-x' }),
      toolResult(id(4), 'call-a', 'contents of a', { parent: id(2) }),
      toolResult(id(5), 'call-b', 'contents of b', { parent: id(3) }),
      reply(id(6), 'both read', { parent: id(5) }),
    ]
    expect(chainFrom(lines, 6)).toEqual(ids(1, 2, 3, 4, 5, 6))
  })

  test('parallel calls: a sibling block the walk skipped comes back with its result', () => {
    const lines = [
      prompt(id(1), 'read both'),
      reply(id(2), [toolUse('call-a')], { parent: id(1), responseId: 'resp-x' }),
      reply(id(3), [toolUse('call-b')], { parent: id(2), responseId: 'resp-x' }),
      toolResult(id(4), 'call-b', 'contents of b', { parent: id(3) }),
      toolResult(id(5), 'call-a', 'contents of a', { parent: id(2) }),
      reply(id(6), 'both read', { parent: id(5) }),
    ]
    expect(chainFrom(lines, 6)).toEqual(ids(1, 2, 3, 4, 5, 6))
  })

  test('hook output and what follows a result come back in write order, whatever their timestamps', () => {
    const lines = [
      prompt(id(1), 'read both', { at: 0 }),
      reply(id(2), [toolUse('call-a')], { parent: id(1), responseId: 'resp-y', at: 1 }),
      reply(id(3), [toolUse('call-b')], { parent: id(2), responseId: 'resp-y', at: 1 }),
      hookOutput(id(4), 'call-a', 'PreToolUse', { parent: id(3), at: 50 }),
      toolResult(id(5), 'call-a', 'contents of a', { parent: id(2), at: 10 }),
      attachment(id(6), { type: 'edited_text_file', filename: '/work/app/a.ts', snippet: 'x' }, { parent: id(5), at: 40 }),
      hookOutput(id(7), 'call-b', 'PreToolUse', { parent: id(6), at: 30 }),
      toolResult(id(8), 'call-b', 'contents of b', { parent: id(3), at: 20 }),
      hookOutput(id(9), 'call-b', 'PostToolUse', { parent: id(8), at: 20 }),
      reply(id(10), 'both read', { parent: id(9), at: 60 }),
    ]
    expect(chainFrom(lines, 10)).toEqual(ids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
  })

  test('an old transcript whose next turn hangs off the assistant gets the result back after it', () => {
    const lines = [
      prompt(id(1), 'read it'),
      reply(id(2), [toolUse('call-x')], { parent: id(1) }),
      toolResult(id(3), 'call-x', 'contents', { parent: id(2) }),
      reply(id(4), 'read', { parent: id(2) }),
    ]
    expect(chainFrom(lines, 4)).toEqual(ids(1, 2, 3, 4))
  })

  test('an assistant entry without a response id brings nothing back', () => {
    const lines = [
      prompt(id(1), 'read it'),
      reply(id(2), [toolUse('call-x')], { parent: id(1), responseId: '' }),
      toolResult(id(3), 'call-x', 'contents', { parent: id(2) }),
      reply(id(4), 'read', { parent: id(2), responseId: '' }),
    ]
    expect(chainFrom(lines, 4)).toEqual(ids(1, 2, 4))
  })

  test('a result for another response is not pulled in', () => {
    const lines = [
      prompt(id(1), 'read it'),
      reply(id(2), [toolUse('call-x')], { parent: id(1) }),
      toolResult(id(3), 'call-x', 'contents', { parent: id(2) }),
      reply(id(4), 'read', { parent: id(3) }),
      prompt(id(5), 'abandoned branch', { parent: id(4) }),
      reply(id(6), [toolUse('call-y')], { parent: id(5) }),
      toolResult(id(7), 'call-y', 'never resumed', { parent: id(6) }),
    ]
    expect(chainFrom(lines, 4)).toEqual(ids(1, 2, 3, 4))
  })

  test('recoverOrphanedParallelToolResults on its own: the chain gains the skipped entries, the map is untouched', () => {
    const lines = [
      prompt(id(1), 'read both'),
      reply(id(2), [toolUse('call-a')], { parent: id(1), responseId: 'resp-z' }),
      reply(id(3), [toolUse('call-b')], { parent: id(2), responseId: 'resp-z' }),
      toolResult(id(4), 'call-a', 'a', { parent: id(2) }),
      toolResult(id(5), 'call-b', 'b', { parent: id(3) }),
    ]
    const map = asMap(lines)
    const walked = ids(1, 2, 3, 5).map(u => map.get(u)!)
    const recovered = recoverOrphanedParallelToolResults(map, walked, new Set(uuids(walked) as UUID[]))
    expect(uuids(recovered)).toEqual(ids(1, 2, 3, 4, 5))
    expect(map.size).toBe(5)

    const noAssistants = [map.get(id(1))!]
    expect(uuids(recoverOrphanedParallelToolResults(map, noAssistants, new Set([id(1)])))).toEqual(ids(1))
  })
})

// --- compaction with a preserved segment -----------------------------------------------

/**
 * Before the boundary: an old exchange (1, 2) and the exchange the compaction
 * kept (3 head, 4 tail). After it: the summary (6) the kept run should follow,
 * and the next turn (7, 8), written as a child of the summary.
 */
function compacted(overrides: { preserved?: Partial<Record<'headUuid' | 'anchorUuid' | 'tailUuid', UUID>>; three?: Line } = {}) {
  const preserved = { headUuid: id(3), anchorUuid: id(6), tailUuid: id(4), ...overrides.preserved }
  return [
    prompt(id(1), 'old question'),
    reply(id(2), 'old answer', { parent: id(1) }),
    overrides.three ?? prompt(id(3), 'kept question', { parent: id(2) }),
    reply(id(4), 'kept answer', { parent: id(3) }),
    compactBoundary(id(5), { preserved }),
    prompt(id(6), 'Summary of the earlier conversation', { parent: id(5), more: { isCompactSummary: true } }),
    prompt(id(7), 'next question', { parent: id(6) }),
    reply(id(8), 'next answer', { parent: id(7) }),
  ]
}

const usageOf = (map: Map<UUID, TranscriptMessage>, n: number) =>
  (map.get(id(n)) as unknown as { message: { usage: Record<string, unknown> } }).message.usage

describe('applyPreservedSegmentRelinks', () => {
  test('a live segment is spliced in after the summary, and the next turn follows its tail', () => {
    const map = asMap(compacted())
    expect(applyPreservedSegmentRelinks(map)).toEqual({ relinkFailed: false })
    expect([...map.keys()]).toEqual(ids(3, 4, 5, 6, 7, 8))
    expect(map.get(id(3))!.parentUuid).toBe(id(6))
    expect(map.get(id(7))!.parentUuid).toBe(id(4))
    expect(uuids(buildConversationChain(map, map.get(id(8))!))).toEqual(ids(5, 6, 3, 4, 7, 8))
  })

  test('the kept replies stop counting the tokens of the context before the compaction', () => {
    const map = asMap(compacted())
    applyPreservedSegmentRelinks(map)
    const kept = usageOf(map, 4)
    const counters = ['cache_read_input_tokens', 'output_tokens', 'input_tokens', 'cache_creation_input_tokens']
    expect(counters.map(counter => kept[counter])).toEqual([0, 0, 0, 0])
    expect(kept.service_tier).toBe('standard')
    expect(usageOf(map, 8).input_tokens).toBe(1200)
  })

  test('relinking writes new entries into the map; the original line objects stay as they were', () => {
    const lines = compacted()
    const map = asMap(lines)
    applyPreservedSegmentRelinks(map)
    expect(lines[2]!.parentUuid).toBe(id(2))
    expect(map.get(id(3))).not.toBe(lines[2] as never)
  })

  test('a segment made stale by a later plain boundary is not spliced, and everything before that boundary goes', () => {
    const lines = [...compacted(), compactBoundary(id(9)), prompt(id(10), 'after the second compaction', { parent: id(9) })]
    const map = asMap(lines)
    expect(applyPreservedSegmentRelinks(map)).toEqual({ relinkFailed: false })
    expect([...map.keys()]).toEqual(ids(9, 10))
  })

  test('without any preserved segment nothing is touched, plain boundaries included', () => {
    const lines = [prompt(id(1), 'old'), compactBoundary(id(2)), prompt(id(3), 'new', { parent: id(2) })]
    const map = asMap(lines)
    expect(applyPreservedSegmentRelinks(map)).toEqual({ relinkFailed: false })
    expect([...map.keys()]).toEqual(ids(1, 2, 3))
  })

  const broken = [
    { name: 'the tail is not in the transcript', overrides: { preserved: { tailUuid: id(77) } } },
    { name: 'the head is never reached', overrides: { preserved: { headUuid: id(88) } } },
    { name: 'a parent on the way is missing', overrides: { three: prompt(id(3), 'kept question', { parent: id(66) }), preserved: { headUuid: id(1) } } },
    { name: 'the way loops', overrides: { three: prompt(id(3), 'kept question', { parent: id(4) }), preserved: { headUuid: id(1) } } },
    { name: 'the anchor is not in the transcript', overrides: { preserved: { anchorUuid: id(55) } } },
  ]
  for (const c of broken) {
    test(`fails closed when ${c.name}: only what follows the boundary is kept`, () => {
      const map = asMap(compacted(c.overrides))
      expect(applyPreservedSegmentRelinks(map)).toEqual({ relinkFailed: true })
      expect([...map.keys()]).toEqual(ids(5, 6, 7, 8))
      expect(map.get(id(7))!.parentUuid).toBe(id(6))
    })
  }
})

// --- snip -------------------------------------------------------------------------------

/** Six alternating turns; entry 7 records a snip of `removed`. */
function snipped(removed: UUID[], extra: Line[] = []): Line[] {
  return [
    prompt(id(1), 'one'),
    reply(id(2), 'two', { parent: id(1) }),
    prompt(id(3), 'three', { parent: id(2) }),
    reply(id(4), 'four', { parent: id(3) }),
    prompt(id(5), 'five', { parent: id(4) }),
    reply(id(6), 'six', { parent: id(5) }),
    notice(id(7), 'snipped', { parent: id(6), more: { snipMetadata: { removedUuids: removed } } }),
    ...extra,
  ]
}

describe('applySnipRemovals', () => {
  const cases = [
    {
      name: 'a removed run is dropped and the survivor after it joins the entry before it',
      lines: snipped(ids(3, 4)),
      keys: ids(1, 2, 5, 6, 7),
      parents: { 5: id(2) },
    },
    {
      name: 'every survivor pointing into the run is rejoined',
      lines: snipped(ids(3, 4), [prompt(id(8), 'a branch off four', { parent: id(4) })]),
      keys: ids(1, 2, 5, 6, 7, 8),
      parents: { 5: id(2), 8: id(2) },
    },
    {
      name: 'a removed entry already gone from the map leaves its survivor as a root',
      lines: snipped(ids(3, 4)).filter(line => line.uuid !== id(3)),
      keys: ids(1, 2, 5, 6, 7),
      parents: { 5: null },
    },
    {
      name: 'a run reaching the root leaves its survivor as a root',
      lines: snipped(ids(1, 2)),
      keys: ids(3, 4, 5, 6, 7),
      parents: { 3: null, 4: id(3) },
    },
    {
      name: 'an empty removal list changes nothing',
      lines: snipped([]),
      keys: ids(1, 2, 3, 4, 5, 6, 7),
      parents: { 3: id(2) },
    },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const map = asMap(c.lines)
      applySnipRemovals(map)
      expect([...map.keys()]).toEqual(c.keys)
      for (const [n, parent] of Object.entries(c.parents)) {
        expect(map.get(id(Number(n)))!.parentUuid).toBe(parent)
      }
    })
  }

  test('removals recorded on several entries all apply, and untouched entries are the same objects', () => {
    const lines = [
      ...snipped(ids(2)),
      notice(id(8), 'snipped again', { parent: id(7), more: { snipMetadata: { removedUuids: [id(5)] } } }),
    ]
    const map = asMap(lines)
    applySnipRemovals(map)
    expect([...map.keys()]).toEqual(ids(1, 3, 4, 6, 7, 8))
    expect(map.get(id(3))!.parentUuid).toBe(id(1))
    expect(map.get(id(6))!.parentUuid).toBe(id(4))
    expect(map.get(id(4))).toBe(lines[3] as never)
  })
})
