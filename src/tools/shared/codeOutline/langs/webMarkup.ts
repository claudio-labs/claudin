// Web-markup scanners — CSS/SCSS, HTML and XML.
//
// Grouped because all three walk tags/blocks over a masked copy and produce
// `selector` / `element` kinds; each keeps its own masker and regexes.

import {
  capSignature,
  RE_WS_RUN,
  trimSignature,
} from 'src/tools/shared/codeOutline/internal.js'
import type {
  SymbolEntry,
  SymbolKind,
} from 'src/tools/shared/codeOutline/types.js'

// ---------------------------------------------------------------------------
// CSS / SCSS scanner — top-level selectors + at-rules
// ---------------------------------------------------------------------------

const RE_CSS_MIXIN = /^@(?:mixin|function)\s+([A-Za-z_][\w-]*)/
const RE_CSS_KEYFRAMES = /^@keyframes\s+([A-Za-z_-][\w-]*)/

export function maskCss(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  let parens = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    const c = source[i]
    const c2 = source[i + 1]
    if (c === '/' && c2 === '*') {
      blank(i++)
      blank(i++)
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) blank(i++)
      if (i < n) {
        blank(i++)
        blank(i++)
      }
      continue
    }
    // SCSS `//` line comment — but not a `:` scheme separator (`http://`) and
    // not inside parens (`url(//cdn.example.com/x.png)` is a URL; blanking the
    // rest of the line would swallow the closing `}`).
    if (c === '/' && c2 === '/' && source[i - 1] !== ':' && parens === 0) {
      while (i < n && source[i] !== '\n') blank(i++)
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      blank(i++)
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\') {
          blank(i++)
          if (i < n) blank(i++)
          continue
        }
        blank(i++)
      }
      if (i < n && source[i] === quote) blank(i++)
      continue
    }
    if (c === '(') parens++
    else if (c === ')' && parens > 0) parens--
    i++
  }
  return out.join('')
}

export function scanCss(source: string): SymbolEntry[] {
  const masked = maskCss(source)
  const n = masked.length
  const results: SymbolEntry[] = []

  let line = 1
  let depth = 0
  let bufStartIdx = -1
  let bufStartLine = -1
  let pendingStartLine = -1
  let pendingSel = ''

  for (let i = 0; i < n; i++) {
    const c = masked[i]
    if (c === '\n') {
      line++
      continue
    }
    if (depth === 0) {
      if (c !== ' ' && c !== '\t' && bufStartIdx < 0) {
        bufStartIdx = i
        bufStartLine = line
      }
      if (c === '{') {
        pendingSel = capSignature(masked.slice(bufStartIdx, i))
        pendingStartLine = bufStartLine
        depth = 1
        bufStartIdx = -1
      } else if (c === ';' || c === '}') {
        // `@import …;`, an SCSS `$var: …;`, or a stray brace — not a block.
        bufStartIdx = -1
      }
    } else {
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          if (pendingSel) {
            let name = pendingSel
            let kind: SymbolKind = 'selector'
            let mm = RE_CSS_MIXIN.exec(pendingSel)
            if (mm) {
              name = mm[1]!
              kind = 'function'
            } else if ((mm = RE_CSS_KEYFRAMES.exec(pendingSel))) {
              name = mm[1]!
            }
            results.push({
              name,
              kind,
              signature: pendingSel,
              startLine: pendingStartLine,
              endLine: line,
              depth: 0,
            })
          }
          pendingSel = ''
          bufStartIdx = -1
        }
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// HTML scanner — headings, landmarks, and id'd elements (not the full tree)
// ---------------------------------------------------------------------------

const RE_HTML_TAG = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
const RE_HTML_ID = /\bid\s*=\s*["']?([\w-]+)/i
const RE_HTML_TAGS_STRIP = /<[^>]*>/g
const RE_HTML_HEADING = /^h[1-6]$/
const HTML_VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const HTML_LANDMARKS = new Set([
  'section',
  'nav',
  'main',
  'header',
  'footer',
  'article',
  'aside',
])

/** Blanks `<!-- -->` comments and `<script>`/`<style>` bodies so their `<`
 *  characters don't parse as tags. Preserves line structure. */
export function maskHtml(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  const lower = source.toLowerCase()
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (lower.startsWith('<script', i) || lower.startsWith('<style', i)) {
      const tag = lower.startsWith('<script', i) ? '</script' : '</style'
      const close = lower.indexOf(tag, i)
      // Blank only the element body, leaving the tags themselves parseable.
      const bodyStart = source.indexOf('>', i)
      if (bodyStart >= 0 && close > bodyStart) {
        i = bodyStart + 1
        while (i < close) blank(i++)
      } else {
        i += 1
      }
      continue
    }
    i++
  }
  return out.join('')
}

export function scanHtml(source: string): SymbolEntry[] {
  const masked = maskHtml(source)
  const results: SymbolEntry[] = []
  type HtmlFrame = {
    tag: string
    entryIndex: number | null
    openEndIdx: number
  }
  const stack: HtmlFrame[] = []
  const trackedDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  // Line number for a char index, computed by advancing a cursor forward as
  // matches arrive in order (avoids an O(n) count per tag).
  let cursor = 0
  let cursorLine = 1
  const lineAt = (idx: number): number => {
    while (cursor < idx) {
      if (masked[cursor] === '\n') cursorLine++
      cursor++
    }
    return cursorLine
  }

  RE_HTML_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE_HTML_TAG.exec(masked)) !== null) {
    const whole = m[0]
    const tag = m[1]!.toLowerCase()
    const attrs = m[2] ?? ''
    const selfClose = m[3] === '/'
    const isClosing = whole.startsWith('</')
    const tagLine = lineAt(m.index)

    if (isClosing) {
      // Pop up to and including the nearest matching open tag.
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.tag === tag) {
          const closed = stack.splice(s)
          const frame = closed[0]!
          if (frame.entryIndex !== null) {
            const entry = results[frame.entryIndex]!
            entry.endLine = tagLine
            if (RE_HTML_HEADING.test(tag)) {
              // Strip tags to a fixpoint — a single pass can leave fragments
              // of nested/split tags behind (CodeQL
              // js/incomplete-multi-character-sanitization).
              let text = masked.slice(frame.openEndIdx, m.index)
              let prev: string
              do {
                prev = text
                text = text.replace(RE_HTML_TAGS_STRIP, '')
              } while (text !== prev)
              text = text.replace(RE_WS_RUN, ' ').trim()
              if (text) {
                entry.name = text
                // Surface the text in the outline body (the signature column),
                // mirroring how a Markdown heading shows its own line.
                entry.signature = capSignature(`<${tag}> ${text}`)
              }
            }
          }
          break
        }
      }
      continue
    }

    const isHeading = RE_HTML_HEADING.test(tag)
    const idMatch = RE_HTML_ID.exec(attrs)
    const isLandmark = HTML_LANDMARKS.has(tag)
    const tracked = isHeading || isLandmark || idMatch !== null

    let entryIndex: number | null = null
    if (tracked) {
      const depth = trackedDepth()
      const name = isHeading
        ? tag // replaced with text content on close
        : idMatch
          ? `${tag}#${idMatch[1]}`
          : tag
      const kind: SymbolKind = isHeading ? 'heading' : 'element'
      results.push({
        name,
        kind,
        signature: capSignature(whole),
        startLine: tagLine,
        endLine: tagLine,
        depth,
      })
      entryIndex = results.length - 1
    }

    if (!selfClose && !HTML_VOID.has(tag)) {
      stack.push({ tag, entryIndex, openEndIdx: m.index + whole.length })
    }
  }

  return results.sort((a, b) => a.startLine - b.startLine)
}

// ---------------------------------------------------------------------------
// XML — tag-stack element tracker (modeled on scanHtml)
// ---------------------------------------------------------------------------

const RE_XML_TAG = /<\/?([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g
const RE_XML_ID = /\bid\s*=\s*["']?([\w:.-]+)/i
const RE_XML_NAME = /\bname\s*=\s*["']?([\w:.-]+)/i

export function maskXml(source: string): string {
  const out = source.split('')
  const n = source.length
  let i = 0
  const blank = (k: number) => {
    if (out[k] !== '\n') out[k] = ' '
  }
  while (i < n) {
    if (source.startsWith('<!--', i)) {
      const close = source.indexOf('-->', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (source.startsWith('<![CDATA[', i)) {
      const close = source.indexOf(']]>', i)
      const end = close < 0 ? n : close + 3
      while (i < end) blank(i++)
      continue
    }
    if (source.startsWith('<?', i)) {
      const close = source.indexOf('?>', i)
      const end = close < 0 ? n : close + 2
      while (i < end) blank(i++)
      continue
    }
    i++
  }
  return out.join('')
}

export function scanXml(source: string): SymbolEntry[] {
  const masked = maskXml(source)
  const results: SymbolEntry[] = []
  type XmlFrame = { tag: string; entryIndex: number | null; openEndIdx: number }
  const stack: XmlFrame[] = []
  const trackedDepth = () =>
    stack.reduce((d, f) => d + (f.entryIndex !== null ? 1 : 0), 0)

  let cursor = 0
  let cursorLine = 1
  const lineAt = (idx: number): number => {
    while (cursor < idx) {
      if (masked[cursor] === '\n') cursorLine++
      cursor++
    }
    return cursorLine
  }

  RE_XML_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  let rootTracked = false
  while ((m = RE_XML_TAG.exec(masked)) !== null) {
    const whole = m[0]
    const tag = m[1]!
    const attrs = m[2] ?? ''
    const selfClose = m[3] === '/'
    const isClosing = whole.startsWith('</')
    const tagLine = lineAt(m.index)

    if (isClosing) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s]!.tag === tag) {
          const closed = stack.splice(s)
          const frame = closed[0]!
          if (frame.entryIndex !== null) {
            results[frame.entryIndex]!.endLine = tagLine
          }
          break
        }
      }
      continue
    }

    let entryIndex: number | null = null
    const idMatch = RE_XML_ID.exec(attrs)
    const nameMatch = RE_XML_NAME.exec(attrs)
    const label = idMatch?.[1] ?? nameMatch?.[1] ?? null
    const isRoot = !rootTracked && stack.length === 0

    if (label || isRoot) {
      rootTracked = true
      const name = label ?? tag
      const depth = trackedDepth()
      results.push({
        name,
        kind: 'element',
        signature: trimSignature(whole),
        startLine: tagLine,
        endLine: tagLine,
        depth,
      })
      entryIndex = results.length - 1
    }

    if (!selfClose) {
      stack.push({ tag, entryIndex, openEndIdx: m.index + whole.length })
    }
  }

  return results.sort((a, b) => a.startLine - b.startLine)
}
