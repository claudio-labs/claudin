import type {
  AttachmentMessage,
  RenderableMessage,
} from 'src/shared/types/message.js'
import type { Attachment } from 'src/agent/attachments/attachments.js'
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
  return { path: attachment.path, displayPath: attachment.displayPath }
}

/**
 * The noun for a collapsed batch: "rules" when every file sits in a rules
 * directory (the common case — a run of `.claudin/rules/*.md`), otherwise the
 * generic "memory files", since nested CLAUDE.md/AGENTS.md files land in the
 * same run.
 */
export function nestedMemoryBatchNoun(
  files: readonly NestedMemoryFile[],
): string {
  const isAllRules = files.every(file => RULES_PATH_RE.test(file.displayPath))
  return plural(files.length, isAllRules ? 'rule' : 'memory file')
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
