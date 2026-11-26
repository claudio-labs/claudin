/**
 * `<pasted_content>` blocks: what a `[Pasted text #N]` ref expands to in a
 * prompt, so the model can tell the user's own words from text they pasted
 * from somewhere else (the harness bullet in prompts.ts says how to treat
 * it). Claude Code 2.1.332's format: both tags carry the same random 4-hex
 * id, which the user never sees.
 *
 * The tags are stored in the message, so what resume re-sends is byte for
 * byte what the model saw. The display sites take them back out with
 * unwrapPastedContent (src/shared/text/displayTags.ts), so each one shows
 * what it showed before the tags existed.
 */
import { randomBytes } from 'crypto'
import type { PastedContent } from 'src/platform/config/config.js'
import { PASTED_CONTENT_TAG } from 'src/shared/constants/xml.js'

export function newPasteId(): string {
  return randomBytes(2).toString('hex')
}

export function wrapPastedText(text: string, id: string): string {
  return `<${PASTED_CONTENT_TAG} id="${id}">\n${text}\n</${PASTED_CONTENT_TAG} id="${id}">\n`
}

/**
 * The text pastes with their content wrapped, for expandPastedTextRefs. Image
 * pastes are left alone: they become content blocks, not inlined text.
 */
export function wrapPastedContents(
  pastedContents: Record<number, PastedContent>,
  newId: () => string = newPasteId,
): Record<number, PastedContent> {
  const wrapped: Record<number, PastedContent> = {}
  for (const [key, content] of Object.entries(pastedContents)) {
    wrapped[Number(key)] =
      content.type === 'text'
        ? { ...content, content: wrapPastedText(content.content, newId()) }
        : content
  }
  return wrapped
}

/**
 * Only a plain prompt is wrapped. A slash command's arguments and a `!` bash
 * command take the paste as their own input, the way they did before the
 * tags existed; the slash test is the one handlePromptSubmit applies before
 * it dispatches a command.
 */
export function shouldWrapPastes({
  input,
  mode,
  skipSlashCommands,
}: {
  input: string
  mode: string
  skipSlashCommands?: boolean
}): boolean {
  if (mode !== 'prompt') return false
  return skipSlashCommands === true || !input.trim().startsWith('/')
}
