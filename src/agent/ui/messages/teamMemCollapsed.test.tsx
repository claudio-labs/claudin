/**
 * The team-memory half of the collapsed badge. Reachable from `bun test` only
 * because this module calls no `feature()` itself — every CALLER of it sits
 * behind a feature('TEAMMEM') fold that is false under the runner
 * (src/stubs/test-preload.ts), so the wiring still needs a live run.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import type { CollapsedReadSearchGroup } from 'src/shared/types/message.js'
import {
  checkHasTeamMemOps,
  getTeamMemoryReadCount,
  TeamMemCountParts,
} from 'src/agent/ui/messages/teamMemCollapsed.js'

function group(
  counts: Partial<CollapsedReadSearchGroup>,
): CollapsedReadSearchGroup {
  return counts as CollapsedReadSearchGroup
}

/**
 * TeamMemCountParts is a plain function, but its React-Compiler cache
 * (`_c(23)`) is a hook — so it has to be called from inside a render, the way
 * CollapsedReadSearchContent calls it.
 */
function Harness({
  counts,
  hasPrecedingParts,
}: {
  counts: Partial<CollapsedReadSearchGroup>
  hasPrecedingParts: boolean
}): React.ReactNode {
  return (
    <Text>
      {TeamMemCountParts({
        message: group(counts),
        isActiveGroup: false,
        hasPrecedingParts,
      })}
    </Text>
  )
}

function render(
  counts: Partial<CollapsedReadSearchGroup>,
  hasPrecedingParts = false,
): Promise<string> {
  return renderToString(
    <Harness counts={counts} hasPrecedingParts={hasPrecedingParts} />,
  ).then(out => stripAnsi(out).replace(/\s+/g, ' ').trim())
}

describe('teamMemCollapsed', () => {
  test('recalled team memories produce no badge part', async () => {
    // They render as a "Loaded …" line instead (memoryRecallLine.ts). The
    // count is still readable from here, which is how that line gets it.
    expect(await render({ teamMemoryReadCount: 2 })).toBe('')
    expect(getTeamMemoryReadCount(group({ teamMemoryReadCount: 2 }))).toBe(2)
    expect(getTeamMemoryReadCount(group({}))).toBe(0)
  })

  test('searches and writes keep their badge verbs', async () => {
    expect(await render({ teamMemorySearchCount: 1 })).toBe(
      'Searched team memories',
    )
    expect(await render({ teamMemoryWriteCount: 1 })).toBe(
      'Wrote 1 team memory',
    )
    expect(
      await render({ teamMemorySearchCount: 1, teamMemoryWriteCount: 2 }),
    ).toBe('Searched team memories, wrote 2 team memories')
  })

  test('a preceding part lowercases the first verb and adds the comma', async () => {
    expect(await render({ teamMemoryWriteCount: 1 }, true)).toBe(
      ', wrote 1 team memory',
    )
  })

  test('a read still counts as a team op for the render gate', () => {
    // CollapsedReadSearchContent uses this to decide whether the group renders
    // at all — a group of nothing but team recalls must not be dropped.
    expect(checkHasTeamMemOps(group({ teamMemoryReadCount: 1 }))).toBe(true)
    expect(checkHasTeamMemOps(group({}))).toBe(false)
  })
})
