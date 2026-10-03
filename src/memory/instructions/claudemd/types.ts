import type { MemoryType } from 'src/memory/memdir/types.js'

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string 
  globs?: string[] 
  // so callers can cache a `isPartialView` readFileState entry, with `content`
  // beside it as `injectedView` — presence in cache provides dedup + change
  // detection, Write still requires an explicit Read, and Edit/Patch
  // are held to the injected text (readBeforeEditMessages.ts).
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

export type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

export type ExternalClaudeMdInclude = {
  path: string
  parent: string
}
