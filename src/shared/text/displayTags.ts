import { PASTED_CONTENT_TAG } from 'src/shared/constants/xml.js'

/**
 * Matches any XML-like `<tag>…</tag>` block (lowercase tag names, optional
 * attributes, multi-line content). Used to strip system-injected wrapper tags
 * from display titles — IDE context, slash-command markers, hook output,
 * task notifications, channel messages, etc. A generic pattern avoids
 * maintaining an ever-growing allowlist that falls behind as new notification
 * types are added.
 *
 * Only matches lowercase tag names (`[a-z][\w-]*`) so user prose mentioning
 * JSX/HTML components ("fix the <Button> layout", "<!DOCTYPE html>") passes
 * through — those start with uppercase or `!`. The non-greedy body with a
 * backreferenced closing tag keeps adjacent blocks separate; unpaired angle
 * brackets ("when x < y") don't match.
 */
const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

// A `<pasted_content>` block as wrapPastedText (src/agent/input/pastedContent.ts)
// writes it: the closing tag repeats the opening tag's id. Each newline the
// writer puts at a boundary is optional or may be a space, because stored
// prompts get trimmed (the queue, the /rewind list) and flattened (titles).
const PASTED_BLOCK_PATTERN = new RegExp(
  `<${PASTED_CONTENT_TAG} id="([0-9a-f]{4})">[\\n ]?([\\s\\S]*?)[\\n ]?</${PASTED_CONTENT_TAG} id="\\1">[\\n ]?`,
  'g',
)

/**
 * The text as the user pasted it: the tags go, the pasted text stays. Every
 * place that shows a prompt back to the user calls this, so it shows what it
 * showed before prompts carried the tags.
 */
export function unwrapPastedContent(text: string): string {
  if (!text.includes(`<${PASTED_CONTENT_TAG} id="`)) return text
  return text.replace(PASTED_BLOCK_PATTERN, '$2')
}

/**
 * Strip XML-like tag blocks from text for use in UI titles (/rewind, /resume,
 * bridge session titles). System-injected context — IDE metadata, hook output,
 * task notifications — arrives wrapped in tags and should never surface as a
 * title. Pasted text is the user's, so it stays in the title, unwrapped.
 *
 * If stripping would result in empty text, returns the original unchanged
 * (better to show something than nothing).
 */
export function stripDisplayTags(text: string): string {
  const unwrapped = unwrapPastedContent(text)
  const result = unwrapped.replace(XML_TAG_BLOCK_PATTERN, '').trim()
  return result || unwrapped
}

/**
 * Like stripDisplayTags but returns empty string when all content is tags.
 * Used by getLogDisplayTitle to detect command-only prompts (e.g. /clear)
 * so they can fall through to the next title fallback, and by extractTitleText
 * to skip pure-XML messages during bridge title derivation.
 */
export function stripDisplayTagsAllowEmpty(text: string): string {
  return unwrapPastedContent(text).replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

const IDE_CONTEXT_TAGS_PATTERN =
  /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * Strip only IDE-injected context tags (ide_opened_file, ide_selection).
 * Used by textForResubmit so UP-arrow resubmit preserves user-typed content
 * including lowercase HTML like `<code>foo</code>` while dropping IDE noise.
 */
export function stripIdeContextTags(text: string): string {
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
