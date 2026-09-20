/**
 * The memory_index arm of AttachmentMessage: the only place the user sees the
 * MEMORY.md indexes load, since claude_md_delta — which carries their content
 * — renders null (nullRenderingAttachments.ts).
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AttachmentMessage } from 'src/agent/ui/messages/AttachmentMessage.js'
import type { Attachment, MemoryIndexSummary } from 'src/agent/attachments/types.js'

function index(
  kind: MemoryIndexSummary['kind'],
  entryCount: number,
  totalEntryCount = entryCount,
): MemoryIndexSummary {
  const dir = kind === 'team' ? '.claudin/memory/team' : '.claudin/memory'
  return {
    path: `/repo/${dir}/MEMORY.md`,
    displayPath: `${dir}/MEMORY.md`,
    kind,
    entryCount,
    totalEntryCount,
  }
}

function render(
  indexes: MemoryIndexSummary[],
  opts: { verbose?: boolean; isTranscriptMode?: boolean; columns?: number } = {},
): Promise<string> {
  const attachment = { type: 'memory_index', indexes } as Attachment
  return renderToString(
    <AppStateProvider>
      <AttachmentMessage
        attachment={attachment}
        addMargin={false}
        verbose={opts.verbose ?? false}
        isTranscriptMode={opts.isTranscriptMode}
      />
    </AppStateProvider>,
    opts.columns,
  ).then(stripAnsi)
}

/**
 * Asserts `haystack` contains all of `needles`, contiguously each and in this
 * order. Width-independent, which is the point: a line split into sibling
 * <Text> columns still contains every word, but interleaved (ink-tui.md §10).
 */
function expectInOrder(haystack: string, needles: string[]): void {
  let at = 0
  for (const needle of needles) {
    const found = haystack.indexOf(needle, at)
    if (found < 0) {
      throw new Error(
        `expected ${JSON.stringify(needle)} at or after index ${at} in:\n${haystack}`,
      )
    }
    at = found + needle.length
  }
}

const flatten = (out: string): string => out.replace(/\s+/g, ' ').trim()

describe('AttachmentMessage — memory_index', () => {
  test('one line naming both directories, with the expand hint', async () => {
    const out = await render([index('auto', 16), index('team', 121)])
    expectInOrder(flatten(out), [
      'Loaded 16 memories, 121 team memories',
      'ctrl+o to expand',
    ])
  })

  test('stays one flowing line at narrow widths', async () => {
    // A width that forces a wrap is the only thing that tells one <Text> from
    // sibling <Text>s laid out as independently-wrapping columns; at 80 the
    // two shapes render identically (ink-tui.md §10).
    for (const columns of [80, 46, 30]) {
      const out = await render([index('auto', 16), index('team', 121)], {
        columns,
      })
      expectInOrder(flatten(out), ['Loaded 16 memories,', '121 team memories'])
    }
  })

  test('a cut index says so on the same line', async () => {
    const out = await render([index('auto', 16), index('team', 96, 121)])
    expectInOrder(flatten(out), [
      'Loaded 16 memories, 96 of 121 team memories',
      '— index truncated',
    ])
  })

  test('no truncation note when both indexes arrived whole', async () => {
    const out = await render([index('auto', 16), index('team', 121)])
    expect(out).not.toContain('index truncated')
  })

  test('the index paths appear only once expanded', async () => {
    const collapsed = await render([index('auto', 16), index('team', 121)])
    expect(collapsed).not.toContain('MEMORY.md')

    const expanded = await render([index('auto', 16), index('team', 121)], {
      verbose: true,
    })
    expectInOrder(flatten(expanded), [
      '.claudin/memory/MEMORY.md',
      '.claudin/memory/team/MEMORY.md',
    ])
  })

  test('transcript mode expands the paths and drops the ctrl+o hint', async () => {
    const out = await render([index('auto', 16)], { isTranscriptMode: true })
    expect(out).toContain('.claudin/memory/MEMORY.md')
    expect(out).not.toContain('ctrl+o')
  })
})
