import { PassThrough } from 'node:stream'

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { createRoot } from 'src/terminal/ink.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { getCliHighlightPromise } from 'src/shared/text/cliHighlight.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { Markdown, StreamingMarkdown } from 'src/terminal/markdown/Markdown.js'
import {
  __TEST_ONLY_getTokenCacheSize,
  __TEST_ONLY_resetTokenCache,
} from 'src/terminal/markdown/markdownTokenCache.js'

// Multi-block document exercising the segment split: paragraphs, heading,
// list, and a closed code fence (all completed top-level blocks).
const DOC = [
  'First paragraph with **bold** text.',
  '## A heading',
  '- item one\n- item two',
  '```ts\nconst x = 1\n```',
  'Closing paragraph.',
].join('\n\n')

// Ordinary prose, paragraph breaks only. This is the shape that costs the
// most while streaming — marked's block tokenizer runs ~718 ms/MB on prose
// against ~2.6 ms/MB for an open fence — so it is the one the token memo
// most affects, and the one whose cut points are most often re-evaluated.
const PROSE = [
  'The first paragraph carries enough words to span a couple of lines once it is wrapped.',
  'A second paragraph follows it, so the segment cut has somewhere to land between blocks.',
  'The third continues the run, keeping the unstable suffix small as the boundary advances.',
  'A closing paragraph ends the reply.',
].join('\n\n')

// One long fenced code block. An unclosed fence lexes as a single `code`
// token with no trailing `space`, so no safe cut exists and the boundary
// never advances — the unstable suffix grows to the whole block, and every
// frame re-lexes it. That makes this the shape where a shared token array is
// handed back most often.
const CODE = [
  '```ts',
  'export function collatz(n: number): number[] {',
  '  const seen: number[] = [n]',
  '  while (n !== 1) {',
  '    n = n % 2 === 0 ? n / 2 : 3 * n + 1',
  '    seen.push(n)',
  '  }',
  '  return seen',
  '}',
  '```',
].join('\n')

// Prose interleaved with fences — the realistic assistant reply, and the
// only shape where cuts and a growing fence alternate.
const MIXED = [
  'Here is what the function does, described in a sentence long enough to wrap.',
  '```ts\nconst doubled = xs.map(x => x * 2)\n```',
  'And a paragraph after the block, so a cut lands on the far side of the fence.',
  '```sh\nbun test src/terminal/markdown/\n```',
  'A closing note.',
].join('\n\n')

function wrap(node: React.ReactNode): React.ReactElement {
  return <AppStateProvider>{node}</AppStateProvider>
}

// Non-TTY stdout makes Ink emit full frames wrapped in DEC synchronized
// update markers (same mechanism staticRender relies on for the FIRST frame
// — here we want the LAST one, after progressive rerenders).
const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  const startIndex = output.lastIndexOf(SYNC_START)
  if (startIndex === -1) return output
  const contentStart = startIndex + SYNC_START.length
  const endIndex = output.indexOf(SYNC_END, contentStart)
  if (endIndex === -1) return output.slice(contentStart)
  return output.slice(contentStart, endIndex)
}

/**
 * Renders each step through a live Ink root (the real streaming path,
 * including segment accumulation across rerenders) and returns the final
 * frame as plain text. Ground truth for "visually identical to <Markdown>".
 */
async function streamLastFrame(steps: string[]): Promise<string> {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  try {
    for (const step of steps) {
      root.render(wrap(<StreamingMarkdown>{step}</StreamingMarkdown>))
      // Let the frame-throttled renderer commit this step before the next.
      await Bun.sleep(30)
    }
    // Capture before unmount — unmounting writes a final clearing frame.
    return stripAnsi(extractLastFrame(output)).trimEnd()
  } finally {
    root.unmount()
    stdout.end()
    await Bun.sleep(25)
  }
}

/** Steps that complete one top-level block at a time, with a mid-block step
 *  (partial last block) between each, so segments accumulate one by one. */
function blockSteps(doc: string, separator: string): string[] {
  const blocks = doc.split(separator)
  const steps: string[] = []
  for (let i = 1; i <= blocks.length; i++) {
    const prefix = blocks.slice(0, i).join(separator)
    steps.push(prefix.slice(0, prefix.length - 5))
    steps.push(i < blocks.length ? `${prefix}${separator}` : prefix)
  }
  return steps
}

/** Reveals one line at a time. Needed for the single-fence shape, where
 *  blockSteps would yield one step: an open fence has no top-level separator
 *  inside it, so the whole block is a single "block". */
function lineSteps(doc: string): string[] {
  const lines = doc.split('\n')
  const steps: string[] = []
  for (let i = 1; i <= lines.length; i++) {
    steps.push(lines.slice(0, i).join('\n'))
  }
  return steps
}

describe('StreamingMarkdown', () => {
  beforeAll(async () => {
    // Resolve the highlighter up front so both renders take the synchronous
    // MarkdownWithHighlight path instead of racing the Suspense fallback.
    await getCliHighlightPromise()
  })

  beforeEach(() => {
    __TEST_ONLY_resetTokenCache()
  })

  test('segmented render matches the non-streaming render', async () => {
    const streaming = await renderToString(
      wrap(<StreamingMarkdown>{DOC}</StreamingMarkdown>),
    )
    const full = await renderToString(wrap(<Markdown>{DOC}</Markdown>))
    expect(streaming).toBe(full)
  })

  test('multi-segment progression matches the non-streaming render', async () => {
    // One block completed per step, so the component accumulates multiple
    // immutable segments (the one-shot test above only ever produces a
    // single segment + suffix).
    const lastFrame = await streamLastFrame(blockSteps(DOC, '\n\n'))
    const full = await renderToString(wrap(<Markdown>{DOC}</Markdown>))
    expect(lastFrame).toBe(full.trimEnd())
  })

  test('CRLF content does not desync the segment boundary', async () => {
    // marked.lexer normalizes \r\n → \n before tokenizing, so raw-length
    // sums are post-normalization. Without normalizing the tracked string
    // the boundary drifts 1 char per CRLF and a later segment cut lands
    // mid-word (regression: StreamingMarkdown advance arithmetic).
    const crlfDoc = DOC.replace(/\n/g, '\r\n')
    const lastFrame = await streamLastFrame(blockSteps(crlfDoc, '\r\n\r\n'))
    const full = await renderToString(wrap(<Markdown>{crlfDoc}</Markdown>))
    expect(lastFrame).toBe(full.trimEnd())
  })

  test('zero-output blocks (html, link defs) after a cut keep their spacing', async () => {
    // formatToken renders html/def tokens as '' but their surrounding space
    // tokens still emit EOLs inside one Ansi — the final render shows TWO
    // blank lines around them. A segment starting with one would lose an
    // EOL to the Ansi leading trim, so cuts must not land right before
    // html/def (regression: StreamingMarkdown safe-cut rule).
    const doc = [
      'First paragraph alpha.',
      '<div>raw html</div>',
      'Second paragraph beta.',
      '[ref]: https://example.com',
      'See the [ref] link gamma.',
      'Closing paragraph delta.',
    ].join('\n\n')
    const lastFrame = await streamLastFrame(blockSteps(doc, '\n\n'))
    const full = await renderToString(wrap(<Markdown>{doc}</Markdown>))
    expect(lastFrame).toBe(full.trimEnd())
  })

  test('streaming render does not pollute the markdown token cache', async () => {
    await renderToString(wrap(<StreamingMarkdown>{DOC}</StreamingMarkdown>))
    expect(__TEST_ONLY_getTokenCacheSize()).toBe(0)
  })

  test('non-streaming render still populates the markdown token cache', async () => {
    await renderToString(wrap(<Markdown>{DOC}</Markdown>))
    expect(__TEST_ONLY_getTokenCacheSize()).toBeGreaterThan(0)
  })

  describe('render equality under the one-slot token memo', () => {
    // cachedLexer hands back the PREVIOUS call's token array whenever the
    // same string arrives twice (markdownTokenCache.ts). StreamingMarkdown
    // walks those tokens to choose its segment cut (Markdown.tsx:212-229),
    // so a SHARED array must not move where the cuts land. These pin the
    // rendered result against the one-shot path, byte for byte, on the three
    // shapes whose cut behaviour differs.
    const SHAPES: ReadonlyArray<{
      name: string
      doc: string
      steps: (doc: string) => string[]
    }> = [
      { name: 'prose', doc: PROSE, steps: doc => blockSteps(doc, '\n\n') },
      { name: 'code fence', doc: CODE, steps: lineSteps },
      { name: 'mixed prose and code', doc: MIXED, steps: doc => blockSteps(doc, '\n\n') },
    ]

    for (const shape of SHAPES) {
      test(`${shape.name}: streamed frames match the one-shot render`, async () => {
        const lastFrame = await streamLastFrame(shape.steps(shape.doc))
        // Cold both the memo slot and the LRU between the runs, so the
        // one-shot render cannot be served anything the streaming run left
        // behind — otherwise the two sides could agree by sharing state
        // rather than by producing the same output.
        __TEST_ONLY_resetTokenCache()
        const full = await renderToString(wrap(<Markdown>{shape.doc}</Markdown>))
        expect(lastFrame).toBe(full.trimEnd())
      })
    }
  })
})
