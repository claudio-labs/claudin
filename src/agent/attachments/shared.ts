import { randomUUID } from 'crypto'
import type { AttachmentMessage } from 'src/shared/types/message.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import { logError } from 'src/shared/log.js'
import { logAntError } from 'src/shared/debug.js'
import { matchingRuleForInput } from 'src/permissions/filePermissions.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { Attachment } from 'src/agent/attachments/types.js'

export async function maybe<A>(
  label: string,
  f: () => Promise<A[]>,
): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // Log only 5% of events to reduce volume
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) returns undefined, so .length would throw
      const attachmentSizeBytes = result
        .filter(a => a !== undefined && a !== null)
        .reduce((total, attachment) => {
          return total + jsonStringify(attachment).length
        }, 0)
    }
    return result
  } catch (e) {
    const duration = Date.now() - startTime
    logError(e)
    // For Ant users, log the full error to help with debugging
    logAntError(`Attachment error in ${label}`, e)

    return []
  }
}

export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

export function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResultBlock).type === 'tool_result' &&
    typeof (b as ToolResultBlock).tool_use_id === 'string'
  )
}

export function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock)
}

export function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
