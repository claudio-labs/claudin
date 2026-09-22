/**
 * The relevant_memories arm of AttachmentMessage. It only renders when no
 * collapse group was open to absorb the attachment (collapseReadSearch.ts), so
 * the two surfaces have to agree on the same "Loaded …" wording.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AttachmentMessage } from 'src/agent/ui/messages/AttachmentMessage.js'
import type { Attachment } from 'src/agent/attachments/types.js'

function memory(name: string) {
  return {
    path: `/repo/.claudin/memory/${name}.md`,
    content: `body of ${name}`,
    mtimeMs: 0,
  }
}

function render(
  names: string[],
  opts: { verbose?: boolean; isTranscriptMode?: boolean } = {},
): Promise<string> {
  const attachment = {
    type: 'relevant_memories',
    memories: names.map(memory),
  } as Attachment
  return renderToString(
    <AppStateProvider>
      <AttachmentMessage
        attachment={attachment}
        addMargin={false}
        verbose={opts.verbose ?? false}
        isTranscriptMode={opts.isTranscriptMode}
      />
    </AppStateProvider>,
  ).then(stripAnsi)
}

const flatten = (out: string): string => out.replace(/\s+/g, ' ').trim()

describe('AttachmentMessage — relevant_memories', () => {
  test('one Loaded line with the count and the expand hint', async () => {
    expect(flatten(await render(['a']))).toContain('⎿ Loaded 1 memory')
    const two = flatten(await render(['a', 'b']))
    expect(two).toContain('⎿ Loaded 2 memories')
    expect(two).toContain('ctrl+o to expand')
  })

  test('the filenames appear only once expanded', async () => {
    expect(await render(['a'])).not.toContain('a.md')
    expect(await render(['a'], { verbose: true })).toContain('a.md')
  })

  test('transcript mode expands the content and drops the ctrl+o hint', async () => {
    const out = await render(['a'], { isTranscriptMode: true })

    expect(out).toContain('body of a')
    expect(out).not.toContain('ctrl+o')
  })

  test('an empty list renders no line at all', async () => {
    expect(flatten(await render([]))).toBe('')
  })
})
