import type {
  AttachmentMessage,
  RenderableMessage,
} from 'src/shared/types/message.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import {
  TEAM_CATEGORIES,
  teamCategoryForPath,
} from 'src/memory/memdir/memoryTypes.js'
import { plural } from 'src/shared/text/stringUtils.js'

type NestedMemoryBatch = Extract<Attachment, { type: 'nested_memory_batch' }>
type NestedMemoryFile = NestedMemoryBatch['files'][number]

const RULES_PATH_RE = /(?:^|[/\\])rules[/\\]/

function isNestedMemoryAttachment(
  msg: RenderableMessage,
): msg is AttachmentMessage {
  return msg.type === 'attachment' && msg.attachment.type === 'nested_memory'
}

function nestedMemoryFile(msg: RenderableMessage): NestedMemoryFile | null {
  if (!isNestedMemoryAttachment(msg)) return null
  const attachment = msg.attachment
  if (attachment.type !== 'nested_memory') return null
  return {
    path: attachment.path,
    displayPath: attachment.displayPath,
    type: attachment.content.type,
  }
}

type BatchGroup = { rank: number; one: string; many: string }

/**
 * Which clause of the count line a file belongs to. Rules and nested
 * CLAUDE.md/AGENTS.md files keep the nouns they had; a memory-directory file
 * — a `paths:` match from pathScopedMemories.ts — reads as what it is: a
 * memory, a team memory, or a team memory of one category, since the
 * directory IS the category (memoryTypes.ts). The rank fixes the order of
 * the clauses whatever order the loaders produced the files in: rules,
 * nested memory files, memories, team memories, then each category.
 */
function batchGroup(file: NestedMemoryFile): BatchGroup {
  if (file.type === 'AutoMem') {
    return { rank: 2, one: 'memory', many: 'memories' }
  }
  if (file.type === 'TeamMem') {
    const category = teamCategoryForPath(file.path)
    if (!category) {
      return { rank: 3, one: 'team memory', many: 'team memories' }
    }
    return {
      rank: 4 + TEAM_CATEGORIES.indexOf(category),
      one: `team ${category.noun} memory`,
      many: `team ${category.noun} memories`,
    }
  }
  if (RULES_PATH_RE.test(file.displayPath)) {
    return { rank: 0, one: 'rule', many: 'rules' }
  }
  return { rank: 1, one: 'memory file', many: 'memory files' }
}

/**
 * The counted clause for a collapsed batch: "5 rules" (the common case — a
 * run of `.claudin/rules/*.md`), "4 team bug memories", or "2 rules, 3 team
 * bug memories" when one Read pulled in both — so the line says what entered
 * context without listing paths (those stay under ctrl+o).
 */
export function nestedMemoryBatchLabel(
  files: readonly NestedMemoryFile[],
): string {
  const counts = new Map<string, BatchGroup & { count: number }>()
  for (const file of files) {
    const group = batchGroup(file)
    const seen = counts.get(group.one)
    if (seen) seen.count++
    else counts.set(group.one, { ...group, count: 1 })
  }
  return [...counts.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(group => `${group.count} ${plural(group.count, group.one, group.many)}`)
    .join(', ')
}

/**
 * Collapses consecutive `nested_memory` attachments into a single
 * `nested_memory_batch` attachment, so loading five rule files renders one
 * "Loaded 5 rules (ctrl+o to expand)" line instead of five ⎿ Loaded lines.
 * A lone attachment is left alone — a count of one buys nothing.
 */
export function collapseNestedMemory(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (!isNestedMemoryAttachment(msg)) {
      result.push(msg)
      i++
      continue
    }

    const files: NestedMemoryFile[] = []
    while (i < messages.length) {
      const file = nestedMemoryFile(messages[i]!)
      if (!file) break
      files.push(file)
      i++
    }

    if (files.length === 1) {
      result.push(msg)
    } else {
      result.push({
        type: 'attachment',
        uuid: msg.uuid,
        timestamp: msg.timestamp,
        attachment: { type: 'nested_memory_batch', files },
      })
    }
  }

  return result
}
