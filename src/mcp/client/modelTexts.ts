// Every sentence this unit puts in front of the model, each a function of the
// facts it states, so tests can pin the facts one template at a time.
import { formatFileSize } from 'src/shared/text/format.js'

const PAGINATION_HINT =
  'If this MCP server provides pagination or filtering tools, use them to request a smaller slice of the data.'

/** Thousands separators, in the user's locale. */
function characters(count: number): string {
  return `${count.toLocaleString()} characters`
}

function oversizedLead(length: number): string {
  return `Error: result (${characters(length)}) exceeds maximum allowed tokens.`
}

export function truncationNotice(capTokens: number): string {
  return [
    `[OUTPUT TRUNCATED - exceeded ${capTokens} token limit]`,
    '',
    `The rest of this tool result was cut off. ${PAGINATION_HINT} Otherwise, inform the user that you are working with truncated output.`,
  ].join('\n')
}

export function saveFailedText(length: number, reason: string): string {
  return `${oversizedLead(length)} Failed to save output to file: ${reason}. ${PAGINATION_HINT}`
}

export function readSavedFileText(
  path: string,
  length: number,
  format: string,
  maxReadLength?: number,
): string {
  const chunkRule =
    maxReadLength === undefined
      ? '- If a read warns that its output was cut short, reduce the chunk size and read that part again.'
      : `- Bash output is limited to ${maxReadLength.toLocaleString()} chars. If a read ends with a [N lines truncated] warning, reduce the chunk size and read that part again. ***DO NOT PROCEED UNTIL YOU HAVE DONE THIS***`
  return [
    `${oversizedLead(length)} Output has been saved to ${path}.`,
    `Format: ${format}`,
    'Work from the saved file instead of an inline result:',
    '- Read it in portions with offset and limit, or search it for what you need.',
    '- For structured queries, use jq.',
    `- To summarize, analyze or review this result, you MUST read the content from the file at ${path} in sequential chunks until 100% of the content has been read.`,
    chunkRule,
    'Before producing ANY summary or analysis, say how much of the content you read. If you did not read the entire content, you MUST explicitly state this.',
    '',
  ].join('\n')
}

export function audioPrefix(serverName: string): string {
  return `[Audio from ${serverName}] `
}

export function resourcePrefix(serverName: string, uri: string): string {
  return `[Resource from ${serverName} at ${uri}] `
}

export function resourceLinkText(name: string, uri: string, description?: string): string {
  const note = description ? ` (${description})` : ''
  return `[Resource link: ${name}] ${uri}${note}`
}

function describeMime(mimeType: string | undefined): string {
  return mimeType || 'unknown type'
}

export function blobSavedText(
  prefix: string,
  filepath: string,
  mimeType: string | undefined,
  size: number,
): string {
  return `${prefix}Binary content (${describeMime(mimeType)}, ${formatFileSize(size)}) saved to ${filepath}`
}

export function blobNotSavedText(
  prefix: string,
  mimeType: string | undefined,
  size: number,
  reason: string,
): string {
  return `${prefix}Binary content (${describeMime(mimeType)}, ${size} bytes) could not be saved to disk: ${reason}`
}

export type ElicitationEnding = {
  action: 'decline' | 'cancel'
  by: 'hook' | 'user'
}

export function elicitationEndedText({ action, by }: ElicitationEnding, tool: string): string {
  const what = action === 'decline' ? 'declined' : 'canceled'
  const who = by === 'hook' ? 'a hook' : 'the user'
  return `URL elicitation was ${what} by ${who}. The tool "${tool}" could not complete because it requires the user to open a URL.`
}
