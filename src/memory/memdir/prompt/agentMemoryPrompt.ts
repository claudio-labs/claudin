import { readMemoryIndex } from 'src/memory/memdir/directory/memoryDirectory.js'
import { ENTRYPOINT_NAME } from 'src/memory/memdir/entrypoint/limits.js'
import { truncateEntrypointContent } from 'src/memory/memdir/entrypoint/truncation.js'
import { buildMemoryLines } from 'src/memory/memdir/prompt/privateMemoryPrompt.js'

const EMPTY_INDEX_NOTE = `Your \`${ENTRYPOINT_NAME}\` is empty for now; the memories you save will be listed here.`

/**
 * The full memory text followed by the index itself, for an agent whose
 * memory is not loaded by the instruction loader. Reads synchronously and
 * creates nothing.
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const index = readMemoryIndex(params.memoryDir)
  return [
    ...buildMemoryLines(
      params.displayName,
      params.memoryDir,
      params.extraGuidelines,
    ),
    `## ${ENTRYPOINT_NAME}`,
    '',
    index.trim() === ''
      ? EMPTY_INDEX_NOTE
      : truncateEntrypointContent(index).content,
  ].join('\n')
}
