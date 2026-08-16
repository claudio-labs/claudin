// Deterministic fixtures for the streaming profile harness.
// Each fixture returns the FINAL text the assistant would have streamed.
// The harness slices it line-by-line to simulate streaming arrivals.

export type Fixture = {
  name: string
  language: string
  text: string
}

const tsBlock = `\`\`\`typescript
import { marked, type Token } from 'marked'
import { formatToken } from './markdown.js'

type StreamState = {
  stablePrefix: string
  unstableSuffix: string
  totalChars: number
}

export function advanceStreamingBoundary(
  current: string,
  state: StreamState,
): StreamState {
  const boundary = state.stablePrefix.length
  const tokens = marked.lexer(current.substring(boundary))
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }
  const stablePrefix =
    advance > 0 ? current.substring(0, boundary + advance) : state.stablePrefix
  const unstableSuffix = current.substring(stablePrefix.length)
  return {
    stablePrefix,
    unstableSuffix,
    totalChars: current.length,
  }
}

export function renderStreaming(
  state: StreamState,
  highlight: HighlightFn,
): string {
  const stable = renderMarkdown(state.stablePrefix, highlight)
  const unstable = renderMarkdown(state.unstableSuffix, highlight)
  return stable + unstable
}

function renderMarkdown(text: string, highlight: HighlightFn): string {
  if (!text) return ''
  const tokens = marked.lexer(text)
  return tokens.map(t => formatToken(t, 'dark', 0, null, null, highlight)).join('')
}

type HighlightFn = {
  highlight: (s: string, opts: { language: string }) => string
  supportsLanguage: (lang: string) => boolean
}
\`\`\``

const pyBlock = `\`\`\`python
from dataclasses import dataclass
from typing import Iterable

@dataclass
class StreamState:
    stable_prefix: str
    unstable_suffix: str
    total_chars: int

def advance_boundary(current: str, state: StreamState) -> StreamState:
    boundary = len(state.stable_prefix)
    remainder = current[boundary:]
    tokens = list(tokenize(remainder))
    last = len(tokens) - 1
    while last >= 0 and tokens[last].kind == 'space':
        last -= 1
    advance = sum(len(t.raw) for t in tokens[:last])
    if advance > 0:
        new_prefix = current[: boundary + advance]
    else:
        new_prefix = state.stable_prefix
    return StreamState(
        stable_prefix=new_prefix,
        unstable_suffix=current[len(new_prefix):],
        total_chars=len(current),
    )

def render_stream(state: StreamState, hl) -> str:
    return render_md(state.stable_prefix, hl) + render_md(state.unstable_suffix, hl)

def render_md(text: str, hl) -> str:
    if not text:
        return ''
    return ''.join(format_token(t, hl) for t in tokenize(text))

def tokenize(text: str) -> Iterable:
    raise NotImplementedError

def format_token(t, hl) -> str:
    raise NotImplementedError
\`\`\``

export const FIXTURES: Record<string, Fixture> = {
  ts50: {
    name: 'ts50',
    language: 'typescript',
    text: `Here's the implementation:\n\n${tsBlock}\n\nThat covers the streaming boundary logic.`,
  },
  py50: {
    name: 'py50',
    language: 'python',
    text: `Try this:\n\n${pyBlock}\n\nLet me know if it works.`,
  },
  // Pure prose — no code, control case to isolate non-highlight overhead.
  prose: {
    name: 'prose',
    language: 'none',
    text:
      'This is a long-form prose answer with no code blocks at all. ' +
      'It exercises the markdown render path without invoking syntax highlighting. ' +
      'We use it as a control case to isolate the cost of the non-highlight portion ' +
      'of the streaming render: lexer, paragraph formatting, ANSI wrapping, and theme ' +
      'application. The text is intentionally long enough to reach realistic streaming ' +
      'durations on the order of a few seconds at typical model token rates, so the ' +
      'measured cost reflects what happens during a full assistant turn rather than a ' +
      'single chunk arrival. We avoid markdown markers like asterisks or backticks here ' +
      'so the fast-path in cachedLexer (no markdown detected, single paragraph token) is ' +
      'engaged for at least part of the run. After this paragraph there is one more.\n\n' +
      'Second paragraph follows so we exercise the multi-block path too. It mirrors the ' +
      'first in length and shape so the harness produces stable measurements across runs.',
  },
}

export function listFixtures(): string[] {
  return Object.keys(FIXTURES)
}

export function getFixture(name: string): Fixture {
  const fx = FIXTURES[name]
  if (!fx) {
    throw new Error(
      `Unknown fixture: ${name}. Available: ${listFixtures().join(', ')}`,
    )
  }
  return fx
}

/**
 * Slice the fixture text into the sequence of "current text" snapshots that
 * StreamingMarkdown would see, mimicking REPL.tsx:1506 which only advances the
 * displayed text on each `\n`. So each step ends in `\n` (except possibly the
 * last). This is the realistic chunk-arrival rate from the renderer's POV,
 * not the model's — sub-line tokens are coalesced upstream.
 */
export function lineSnapshots(fullText: string): string[] {
  const out: string[] = []
  let cursor = 0
  while (cursor < fullText.length) {
    const nextNewline = fullText.indexOf('\n', cursor)
    if (nextNewline === -1) {
      out.push(fullText)
      break
    }
    cursor = nextNewline + 1
    out.push(fullText.substring(0, cursor))
  }
  // If the last char wasn't a newline we appended fullText already; otherwise
  // append the final state to ensure the closing fence (if any) is present.
  if (out[out.length - 1] !== fullText) out.push(fullText)
  return out
}
