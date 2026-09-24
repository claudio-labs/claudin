/**
 * Escape XML/HTML special characters for safe interpolation into element
 * text content (between tags). Use when untrusted strings (process stdout,
 * user input, external data) go inside `<tag>${here}</tag>`.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape for interpolation into a double- or single-quoted attribute value:
 * `<tag attr="${here}">`. Escapes quotes in addition to `& < >`.
 */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

const ATTRIBUTE_RE = /([A-Za-z][\w-]*)="([^"]*)"/g
const ENTITY_RE = /&(amp|lt|gt|quot|apos);/g
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Reverse of `escapeXmlAttr`. */
export function unescapeXmlAttr(s: string): string {
  return s.replace(ENTITY_RE, (_, name: string) => ENTITIES[name] ?? '')
}

/**
 * Escape every opening or closing `tag` inside `body`, in any case, so text
 * placed between `<tag>` and `</tag>` can neither close the element early nor
 * open a forged one. Everything else in the body stays literal — code in a
 * message keeps its `<` and `&`.
 */
export function neutralizeXmlTag(body: string, tag: string): string {
  const lower = body.toLowerCase()
  const openNeedle = `<${tag.toLowerCase()}`
  const closeNeedle = `</${tag.toLowerCase()}`
  let out = ''
  let from = 0
  for (;;) {
    const open = lower.indexOf(openNeedle, from)
    const close = lower.indexOf(closeNeedle, from)
    const next = open === -1 ? close : close === -1 ? open : Math.min(open, close)
    if (next === -1) break
    out += `${body.slice(from, next)}&lt;`
    from = next + 1
  }
  return out + body.slice(from)
}

/**
 * `<tag a="1">\nbody\n</tag>` — the envelope one agent's message travels in
 * to another. Attribute values are escaped and `undefined` ones dropped; the
 * body is neutralized against its own tag.
 */
export function formatXmlEnvelope(
  tag: string,
  attrs: Record<string, string | undefined>,
  body: string,
): string {
  const attrText = Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXmlAttr(value)}"`)
    .join('')
  return `<${tag}${attrText}>\n${neutralizeXmlTag(body, tag)}\n</${tag}>`
}

export type XmlEnvelope = {
  attrs: Record<string, string>
  body: string
  /** Whatever follows the closing tag, trimmed. */
  trailer: string
}

/**
 * Parse an envelope `formatXmlEnvelope` built. Null unless `text` starts with
 * one, so prose that merely mentions the tag is not mistaken for it.
 */
export function parseXmlEnvelope(text: string, tag: string): XmlEnvelope | null {
  const trimmed = text.trimStart()
  const open = `<${tag}`
  if (!trimmed.startsWith(open)) return null
  const next = trimmed[open.length]
  if (next !== '>' && next !== ' ') return null
  const headerEnd = trimmed.indexOf('>', open.length)
  if (headerEnd === -1) return null
  const close = `</${tag}>`
  const closeAt = trimmed.indexOf(close, headerEnd)
  if (closeAt === -1) return null

  const attrs: Record<string, string> = {}
  for (const [, name, value] of trimmed
    .slice(open.length, headerEnd)
    .matchAll(ATTRIBUTE_RE)) {
    attrs[name!] = unescapeXmlAttr(value!)
  }
  let body = trimmed.slice(headerEnd + 1, closeAt)
  if (body.startsWith('\n')) body = body.slice(1)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  return { attrs, body, trailer: trimmed.slice(closeAt + close.length).trim() }
}
