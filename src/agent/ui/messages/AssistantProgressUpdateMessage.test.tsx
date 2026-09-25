import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { AssistantProgressUpdateMessage } from 'src/agent/ui/messages/AssistantProgressUpdateMessage.js'
import { BLACK_CIRCLE } from 'src/shared/constants/figures.js'
import { renderToAnsiString, renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'

const UPDATE = 'Found the five call sites; renaming the definition next.'

type Props = React.ComponentProps<typeof AssistantProgressUpdateMessage>

function element(over: Partial<Props>): React.ReactNode {
  return (
    <AppStateProvider>
      <AssistantProgressUpdateMessage text={UPDATE} addMargin={false} shouldShowDot={true} model="claude-opus-5-5" {...over} />
    </AppStateProvider>
  )
}

function render(over: Partial<Props>): Promise<string> {
  return renderToString(element(over))
}

/** Every run of whitespace, NBSP included, as one space: what the eye reads. */
function flatten(out: string): string {
  return out.replace(/\s+/g, ' ').trim()
}

describe('AssistantProgressUpdateMessage', () => {
  // Claude Code draws an update as a reply. The ∴ it wore before is the
  // thinking glyph, and read as leaked reasoning.
  test('draws the assistant dot and the text, not the thinking glyph', async () => {
    const out = flatten(await render({}))
    expect(out).toBe(`${BLACK_CIRCLE} ${UPDATE}`)
    expect(out).not.toContain('∴')
  })

  test('another model closes the text with " · summarized"', async () => {
    expect(flatten(await render({ model: 'claude-fable-5-1' }))).toBe(`${BLACK_CIRCLE} ${UPDATE} · summarized`)
  })

  test('without shouldShowDot there is no dot', async () => {
    expect(flatten(await render({ shouldShowDot: false }))).toBe(UPDATE)
  })
})

describe('AssistantProgressUpdateMessage styling', () => {
  // bun test renders without color: raise chalk's level here, then put it back.
  let savedLevel: typeof chalk.level
  beforeAll(() => {
    savedLevel = chalk.level
    chalk.level = 1
  })
  afterAll(() => {
    chalk.level = savedLevel
  })

  // Dim was what made an update read as reasoning; only the hint stays dim.
  test('the text is drawn in the normal color and only the hint is dim', async () => {
    const DIM = '\u001b[2m'
    const out = await renderToAnsiString(element({ model: 'claude-fable-5-1' }))
    const at = out.indexOf(UPDATE)
    expect(at).toBeGreaterThan(-1)
    expect(out.slice(0, at)).not.toContain(DIM)
    expect(out.slice(at)).toContain(`${DIM}\u00B7\u00A0summarized`)
  })
})
