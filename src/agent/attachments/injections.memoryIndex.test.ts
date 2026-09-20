/**
 * toMemoryIndexSummary is the half of the memory-index producer that has to be
 * right: it turns a MemoryFileInfo into the counts the transcript line prints.
 * Pure, so these need no module mock — the gating and dedup halves are pinned
 * end-to-end in attachments.orchestrator.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import { toMemoryIndexSummary } from 'src/agent/attachments/injections.js'

const AUTO_INDEX = [
  '# Memory',
  '',
  '- [First](first.md) — a hook',
  '- [Second](second.md) — another hook',
].join('\n')

function memoryFile(over: Partial<MemoryFileInfo>): MemoryFileInfo {
  return {
    path: '/repo/.claudin/memory/MEMORY.md',
    type: 'AutoMem',
    content: AUTO_INDEX,
    ...over,
  } as MemoryFileInfo
}

describe('toMemoryIndexSummary', () => {
  test('counts the pointer lines, not the headers or blanks', () => {
    expect(toMemoryIndexSummary(memoryFile({})).entryCount).toBe(2)
  })

  test('tags the team index as team and everything else as auto', () => {
    expect(toMemoryIndexSummary(memoryFile({})).kind).toBe('auto')
    expect(
      toMemoryIndexSummary(
        memoryFile({
          type: 'TeamMem',
          path: '/repo/.claudin/memory/team/MEMORY.md',
        }),
      ).kind,
    ).toBe('team')
  })

  test('totalEntryCount comes from rawContent — that is the truncation signal', () => {
    // parsing.ts keeps the untruncated body in rawContent whenever the loaded
    // content differs from disk, which is how the pre-truncation total is
    // recoverable without a second read of the file.
    const summary = toMemoryIndexSummary(
      memoryFile({
        content: `${AUTO_INDEX}\n\n> WARNING: MEMORY.md is 143 lines (limit: 200). Only part of it was loaded.`,
        rawContent: `${AUTO_INDEX}\n- [Third](third.md) — cut off\n- [Fourth](fourth.md) — cut off`,
      }),
    )
    expect(summary.entryCount).toBe(2)
    expect(summary.totalEntryCount).toBe(4)
  })

  test("the appended WARNING line is not counted as an entry", () => {
    const summary = toMemoryIndexSummary(
      memoryFile({
        content: `${AUTO_INDEX}\n\n> WARNING: MEMORY.md is 26.1 KB (limit: 25.0 KB) — index entries are too long.`,
      }),
    )
    expect(summary.entryCount).toBe(2)
  })

  test('no rawContent means nothing was cut', () => {
    const summary = toMemoryIndexSummary(memoryFile({}))
    expect(summary.totalEntryCount).toBe(summary.entryCount)
  })

  test('a rawContent SHORTER than content never reports a negative cut', () => {
    // rawContent also differs from content for a frontmatter or HTML-comment
    // strip, which can only remove non-bullet lines — but clamping keeps a
    // future stripper from rendering "4 of 2 memories".
    const summary = toMemoryIndexSummary(
      memoryFile({ rawContent: '- [Only one](one.md) — hook' }),
    )
    expect(summary.totalEntryCount).toBe(2)
  })
})
