/**
 * Attachment types that were deleted keep showing up on --resume: the
 * transcript was written while they existed. AttachmentMessage must render
 * nothing for one rather than throw, since a crash here takes the whole
 * transcript view down with it.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AttachmentMessage } from 'src/agent/ui/messages/AttachmentMessage.js'
import type { Attachment } from 'src/agent/attachments/types.js'

function render(attachment: Attachment, verbose = false): Promise<string> {
  return renderToString(
    <AppStateProvider>
      <AttachmentMessage
        attachment={attachment}
        addMargin={false}
        verbose={verbose}
        isTranscriptMode={false}
      />
    </AppStateProvider>,
  ).then(stripAnsi)
}

describe('AttachmentMessage — legacy attachment types', () => {
  test('relevant_memories (recall deleted 2026-09) renders nothing and does not throw', async () => {
    // No longer in the Attachment union, so it has to be smuggled past the
    // type — exactly what a resumed JSONL does at runtime.
    const legacy = {
      type: 'relevant_memories',
      memories: [
        {
          path: '/repo/.claudin/memory/a.md',
          content: 'fact A',
          mtimeMs: 1700000000000,
        },
      ],
    } as unknown as Attachment

    for (const verbose of [false, true]) {
      const out = await render(legacy, verbose)
      expect(out.trim()).toBe('')
    }
  })
})
