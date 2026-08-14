import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { useRef } from 'react'
import { renderToString } from 'src/components/staticRender.js'
import type { JumpHandle } from 'src/components/VirtualMessageList.js'
import { TranscriptSearchBar } from './TranscriptSearchBar.js'

// `TranscriptSearchBar` initialises `indexStatus` to `'building'`, so the
// first rendered frame always shows the "indexing…" pill in the right slot
// regardless of `count`/`current`. The counter ("2/5", "no matches") only
// appears on a later render once the mount-effect resolves the warm-up
// (or short-circuits via `setIndexStatus(null)` when `jumpRef.current` is
// null). `renderToString` captures only the first frame, so these tests
// assert on the persistent visual elements: the slash prompt, the seed
// query text and the indexing pill.

function Host({
  count,
  current,
  initialQuery,
}: {
  count: number
  current: number
  initialQuery: string
}): React.ReactNode {
  const jumpRef = useRef<JumpHandle | null>(null)
  return (
    <TranscriptSearchBar
      jumpRef={jumpRef}
      count={count}
      current={current}
      initialQuery={initialQuery}
      onClose={() => {}}
      onCancel={() => {}}
      setHighlight={() => {}}
    />
  )
}

describe('TranscriptSearchBar', () => {
  test('empty query: shows the slash prompt and the indexing pill', async () => {
    const out = await renderToString(<Host count={0} current={0} initialQuery="" />)
    expect(out).toContain('/')
    expect(out).toContain('indexing')
  })

  test('with non-empty seed: renders the seed text after the slash', async () => {
    const out = await renderToString(<Host count={0} current={0} initialQuery="foo" />)
    expect(out).toContain('/foo')
  })

  test('renders the single-border-top chrome around the slash prompt', async () => {
    const out = await renderToString(<Host count={5} current={2} initialQuery="bar" />)
    // The single-line top border ('─' repeated) is part of the shared
    // chrome that distinguishes the bar from a bare prompt.
    expect(out).toContain('────')
    expect(out).toContain('/bar')
  })
})
