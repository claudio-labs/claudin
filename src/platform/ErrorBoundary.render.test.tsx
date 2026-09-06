import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { ErrorBoundary } from 'src/platform/ErrorBoundary.js'

function Boom(): React.ReactNode {
  throw new Error('render exploded')
}

// Without a boundary in front of it, a throw during render reaches Ink's root,
// which swaps the WHOLE tree for its error screen and never resets
// (terminal/ink/components/App.tsx) — the REPL and every key handler go with
// it. These pin the two halves of the escape: the rest of the tree survives,
// and the owner is told so it can unmount the boundary.
describe('ErrorBoundary under a real render', () => {
  test('a throwing child does not take its siblings down', async () => {
    const out = await renderToString(
      <>
        <Text>before</Text>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
        <Text>after</Text>
      </>,
    )
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).not.toContain('render exploded')
  })

  test('the fallback is rendered in the throwing child\u2019s place', async () => {
    const out = await renderToString(
      <ErrorBoundary fallback={<Text>dialog closed</Text>}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(out).toContain('dialog closed')
  })

  test('onError fires, which is how the owner closes the dialog', async () => {
    const onError = mock((_e: Error) => {})
    await renderToString(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]?.message).toBe('render exploded')
  })
})
