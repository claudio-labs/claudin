import type {
  AttachmentMessage,
  RenderableMessage,
} from 'src/shared/types/message.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
import {
  MEMORY_SCOPE_SPECS,
  MEMORY_SCOPES,
  scopeOfMemoryType,
} from 'src/memory/memdir/memoryScopes.js'
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

// Rules, then nested instruction files, then one rank per memory scope, then
// the team categories.
const FIRST_SCOPE_RANK = 2
const FIRST_CATEGORY_RANK = FIRST_SCOPE_RANK + MEMORY_SCOPES.length

/**
 * Which clause of the count line a file belongs to. Rules and nested
 * CLAUDE.md/AGENTS.md files keep the nouns they had; a memory-directory file
 * — a `paths:` match from pathScopedMemories.ts — is named by its scope, the
 * way a Read of one is ("2 private memories", countMemories in
 * memoryScopes.ts): a private memory, a team memory, or, in a scope with
 * subdirectories, a team memory of one category, since the directory IS the
 * category (memoryTypes.ts). The rank fixes the order of the clauses whatever
 * order the loaders produced the files in: rules, nested memory files, the
 * scopes in MEMORY_SCOPES order, then each category.
 */
function batchGroup(file: NestedMemoryFile): BatchGroup {
  const scope = scopeOfMemoryType(file.type)
  if (scope !== null) {
    const category = MEMORY_SCOPE_SPECS[scope].hasSubdirectories
      ? teamCategoryForPath(file.path)
      : undefined
    if (!category) {
      return {
        rank: FIRST_SCOPE_RANK + MEMORY_SCOPES.indexOf(scope),
        one: `${scope} memory`,
        many: `${scope} memories`,
      }
    }
    return {
      rank: FIRST_CATEGORY_RANK + TEAM_CATEGORIES.indexOf(category),
      one: `${scope} ${category.noun} memory`,
      many: `${scope} ${category.noun} memories`,
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
