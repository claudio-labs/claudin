import type { MemoryType } from 'src/memory/memdir/types.js'

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // Path of the file that included this one
  globs?: string[] // Glob patterns for file paths this rule applies to
  // True when auto-injection transformed `content` (stripped HTML comments,
  // stripped frontmatter, truncated MEMORY.md) such that it no longer matches
  // the bytes on disk. When set, `rawContent` holds the unmodified disk bytes
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
