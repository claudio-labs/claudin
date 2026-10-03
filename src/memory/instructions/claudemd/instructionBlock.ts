import type { MemoryType } from 'src/memory/memdir/types.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

/** What the model is told about each file's origin. */
const MEMORY_TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  Managed: "instructions set by the organization's managed policy",
  User: "the user's private global instructions, for all projects",
  Project: 'project instructions, checked into the codebase',
  Local: "the user's private project instructions, not checked in",
  AutoMem: "the user's auto-memory, which persists across conversations",
  TeamMem: 'shared team memory, git-tracked in the project',
}

const BLOCK_SEPARATOR = '\n\n'

export type InstructionBlockOptions = {
  preamble: string
  filter?: (type: MemoryType) => boolean
  /** Fence the team index as shared content, so the model can tell it apart from the user's own text. */
  fenceTeamMemory: boolean
}

export function renderInstructionBlock(
  files: readonly MemoryFileInfo[],
  { preamble, filter, fenceTeamMemory }: InstructionBlockOptions,
): string {
  const blocks = files
    .filter(file => file.content !== '' && (filter === undefined || filter(file.type)))
    .map(file => {
      const text = file.content.trim()
      const body =
        fenceTeamMemory && file.type === 'TeamMem'
          ? `<team-memory-content source="shared">\n${text}\n</team-memory-content>`
          : text
      return `Contents of ${file.path} (${MEMORY_TYPE_LABELS[file.type]}):${BLOCK_SEPARATOR}${body}`
    })
  return blocks.length === 0 ? '' : [preamble, ...blocks].join(BLOCK_SEPARATOR)
}
