/** The text of a message's content: the string itself, or its text blocks, in order. */
export function textBlocks(content: string | readonly { type: string }[]): string[] {
  if (typeof content === 'string') return [content]
  return content.filter(isTextBlock).map(block => block.text)
}

function isTextBlock(block: { type: string }): block is { type: 'text'; text: string } {
  return block.type === 'text'
}
