import { c as _c } from "react-compiler-runtime";
import { marked, type Token, type Tokens } from 'marked';
import React, { Suspense, use, useMemo, useRef } from 'react';
import { useSettings } from 'src/hooks/useSettings.js';
import { Ansi, Box, useTheme } from 'src/ink.js';
import { type CliHighlight, getCliHighlightPromise } from 'src/utils/text/cliHighlight.js';
import { configureMarked, formatToken } from 'src/utils/text/markdown.js';
import { stripPromptXMLTags } from 'src/services/messages/messages.js';
import { cachedLexer } from './markdownTokenCache.js';
import { MarkdownTable } from './MarkdownTable.js';

// marked.lexer normalizes \r\n → \n BEFORE tokenizing, so token raw lengths
// sum over the normalized string. StreamingMarkdown's boundary arithmetic
// indexes into its own copy of the source — normalize first or the boundary
// desyncs on CRLF content (segment cut mid-word, never self-heals).
const CRLF_RE = /\r\n/g;
type Props = {
  children: string;
  /** When true, render all text content as dim */
  dimColor?: boolean;
  /** Streaming-path content: unique string per frame/segment — lex without
   *  inserting into the markdown token cache (see markdownTokenCache.ts). */
  transient?: boolean;
};

/** MarkdownBody additionally receives the resolved (or skipped) highlighter. */
type MarkdownBodyProps = Props & {
  highlight: CliHighlight | null;
};

/**
 * Renders markdown content using a hybrid approach:
 * - Tables are rendered as React components with proper flexbox layout
 * - Other content is rendered as ANSI strings via formatToken
 */
export function Markdown(props: Props) {
  const $ = _c(4);
  const settings = useSettings();
  if (settings.syntaxHighlightingDisabled) {
    let t0;
    if ($[0] !== props) {
      t0 = <MarkdownBody {...props} highlight={null} />;
      $[0] = props;
      $[1] = t0;
    } else {
      t0 = $[1];
    }
    return t0;
  }
  let t0;
  if ($[2] !== props) {
    t0 = <Suspense fallback={<MarkdownBody {...props} highlight={null} />}><MarkdownWithHighlight {...props} /></Suspense>;
    $[2] = props;
    $[3] = t0;
  } else {
    t0 = $[3];
  }
  return t0;
}
function MarkdownWithHighlight(props: Props) {
  const $ = _c(4);
  let t0: Promise<CliHighlight | null>;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = getCliHighlightPromise();
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  const highlight = use(t0);
  let t1;
  if ($[1] !== highlight || $[2] !== props) {
    t1 = <MarkdownBody {...props} highlight={highlight} />;
    $[1] = highlight;
    $[2] = props;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
function MarkdownBody(t0: MarkdownBodyProps) {
  const $ = _c(8);
  const {
    children,
    dimColor,
    highlight,
    transient
  } = t0;
  const [theme] = useTheme();
  configureMarked();
  let elements;
  if ($[0] !== children || $[1] !== dimColor || $[2] !== highlight || $[3] !== theme || $[4] !== transient) {
    const tokens = cachedLexer(stripPromptXMLTags(children), transient);
    elements = [];
    let nonTableContent = "";
    const flushNonTableContent = function flushNonTableContent() {
      if (nonTableContent) {
        elements.push(<Ansi key={elements.length} dimColor={dimColor}>{nonTableContent.trim()}</Ansi>);
        nonTableContent = "";
      }
    };
    for (const token of tokens) {
      if (token.type === "table") {
        flushNonTableContent();
        elements.push(<MarkdownTable key={elements.length} token={token as Tokens.Table} highlight={highlight} />);
      } else {
        nonTableContent = nonTableContent + formatToken(token, theme, 0, null, null, highlight);
        nonTableContent;
      }
    }
    flushNonTableContent();
    $[0] = children;
    $[1] = dimColor;
    $[2] = highlight;
    $[3] = theme;
    $[4] = transient;
    $[5] = elements;
  } else {
    elements = $[5];
  }
  const elements_0 = elements;
  let t1;
  if ($[6] !== elements_0) {
    t1 = <Box flexDirection="column" gap={1}>{elements_0}</Box>;
    $[6] = elements_0;
    $[7] = t1;
  } else {
    t1 = $[7];
  }
  return t1;
}
type StreamingProps = {
  children: string;
};

// Segment props are immutable ({children: string, transient: true}), so a
// shallow-equal memo lets per-frame StreamingMarkdown re-renders bail for
// every completed segment instead of re-running each one's compiled memo
// chain (Markdown → Suspense → MarkdownWithHighlight → MarkdownBody).
const MemoizedMarkdown = React.memo(Markdown);

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta. marked.lexer() correctly handles
 * unclosed code fences as a single token, so block boundaries are always safe.
 *
 * Completed blocks are chunked into immutable segments, each rendered as its
 * own <Markdown> with a stable key. A boundary advance therefore lexes and
 * formats only the NEW segment — rendering the whole prefix through a single
 * growing <Markdown> would re-lex + re-format every prior block on each
 * paragraph boundary (~quadratic over a long reply).
 *
 * Segments only close at "safe" cut points — a [paragraph|code] token
 * followed by a single [space] token — because sibling <Markdown>s join with
 * Box gap={1} (exactly one blank line), which matches formatToken's in-Ansi
 * spacing only for those tails (paragraph/code emit one trailing EOL + one
 * for the space). Headings emit two trailing EOLs, lists/blockquotes vary,
 * and "p\n## H" has no space token at all — those blocks ride along in the
 * growing region until the next safe boundary, so their exact intra-segment
 * spacing is preserved. Worst case (no paragraphs at all): no segmentation,
 * same cost profile as the pre-segmentation code.
 *
 * Known (transient-only) limitation: segments lex independently, so a
 * reference-style link definition ([ref]: url) frozen in an earlier segment
 * won't resolve in later ones mid-stream; the post-stream render of the
 * full message is unaffected.
 *
 * The stable boundary only advances (monotonic), so ref mutation during render
 * is idempotent and safe under StrictMode double-rendering. Component unmounts
 * between turns (streamingText → null), resetting the refs.
 */
export function StreamingMarkdown({
  children
}: StreamingProps): React.ReactNode {
  // React Compiler: this component reads and writes stablePrefixRef.current
  // during render by design. The boundary only advances (monotonic), so
  // the ref mutation is idempotent under StrictMode double-render — but the
  // compiler can't prove that, and memoizing around the ref reads would
  // break the algorithm (stale boundary). Opt out.
  'use no memo';

  configureMarked();

  // Strip before boundary tracking so it matches <Markdown>'s stripping
  // (line 29). When a closing tag arrives, stripped(N+1) is not a prefix
  // of stripped(N), but the startsWith reset below handles that with a
  // one-time re-lex on the smaller stripped string. CRLF is normalized so
  // advance sums (token raw lengths, post-marked-normalization) index
  // correctly into this string; rendering is unaffected (marked normalizes
  // internally either way).
  const stripped = stripPromptXMLTags(children).replace(CRLF_RE, '\n');
  const stablePrefixRef = useRef('');
  const stableSegmentsRef = useRef<string[]>([]);

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = '';
    stableSegmentsRef.current = [];
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = stablePrefixRef.current.length;
  const tokens = marked.lexer(stripped.substring(boundary));

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1;
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--;
  }

  // Last safe cut point before the growing block (see doc comment above).
  let cutIdx = -1;
  for (let i = 1; i < lastContentIdx; i++) {
    const prevType = tokens[i - 1]!.type;
    // html/def tokens render as '' but their surrounding space tokens still
    // emit EOLs inside one Ansi; a segment can't START with one (the Ansi
    // leading trim would eat that spacing, dropping a blank line vs the
    // final render) — so they ride inside the next segment instead.
    const nextType = tokens[i + 1]!.type;
    if (
      tokens[i]!.type === 'space' &&
      (prevType === 'paragraph' || prevType === 'code') &&
      nextType !== 'html' &&
      nextType !== 'def'
    ) {
      cutIdx = i;
    }
  }
  if (cutIdx >= 0) {
    let advance = 0;
    for (let i_1 = 0; i_1 <= cutIdx; i_1++) {
      advance += tokens[i_1]!.raw.length;
    }
    const segment = stripped.substring(boundary, boundary + advance);
    // Defensive — a safe cut always contains at least one paragraph/code
    // block, but an empty segment would render as a stray gap row.
    if (segment.trim()) {
      stableSegmentsRef.current.push(segment);
    }
    stablePrefixRef.current = stripped.substring(0, boundary + advance);
  }
  const unstableSuffix = stripped.substring(stablePrefixRef.current.length);

  // Each segment is memoized inside <Markdown> via useMemo([children, ...])
  // so it never re-parses as the unstable suffix grows. transient: streaming
  // strings are unique per frame/segment — keep them out of the token cache.
  return <Box flexDirection="column" gap={1}>
      {stableSegmentsRef.current.map((segment_0, i_0) => <MemoizedMarkdown key={i_0} transient>{segment_0}</MemoizedMarkdown>)}
      {unstableSuffix && <Markdown transient>{unstableSuffix}</Markdown>}
    </Box>;
}
