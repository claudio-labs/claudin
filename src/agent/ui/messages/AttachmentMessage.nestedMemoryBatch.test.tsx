/**
 * The nested_memory_batch arm of AttachmentMessage: the count line a run of
 * on-demand loads collapses into (collapseNestedMemory.ts). The label text
 * is pinned in collapseNestedMemory.test.ts; this checks the arm renders
 * it, with the paths only under ctrl+o.
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AttachmentMessage } from 'src/agent/ui/messages/AttachmentMessage.js'
import type { Attachment } from 'src/agent/attachments/types.js'

type BatchFile = Extract<
  Attachment,
  { type: 'nested_memory_batch' }
>['files'][number]

function teamBug(name: string): BatchFile {
  const displayPath = `.claudin/memory/team/bugs/${name}.md`
  return { path: `/repo/${displayPath}`, displayPath, type: 'TeamMem' }
}

function render(
  files: BatchFile[],
  opts: { verbose?: boolean; isTranscriptMode?: boolean } = {},
): Promise<string> {
  const attachment = { type: 'nested_memory_batch', files } as Attachment
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

describe('AttachmentMessage — nested_memory_batch', () => {
  test('counts what loaded, with the expand hint and no paths', async () => {
    const out = flatten(
      await render([teamBug('a'), teamBug('b'), teamBug('c'), teamBug('d')]),
    )
    expect(out).toContain('Loaded 4 team bug memories')
    expect(out).toContain('ctrl+o to expand')
    expect(out).not.toContain('bugs/a.md')
  })

  test('the paths appear only once expanded', async () => {
    const out = flatten(await render([teamBug('a'), teamBug('b')], { verbose: true }))
    expect(out).toContain('Loaded 2 team bug memories')
    expect(out).toContain('Loaded .claudin/memory/team/bugs/a.md')
    expect(out).toContain('Loaded .claudin/memory/team/bugs/b.md')
  })

  test('transcript mode expands the paths and drops the ctrl+o hint', async () => {
    const out = flatten(await render([teamBug('a'), teamBug('b')], { isTranscriptMode: true }))
    expect(out).toContain('.claudin/memory/team/bugs/a.md')
    expect(out).not.toContain('ctrl+o')
  })
})
