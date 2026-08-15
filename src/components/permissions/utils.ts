import { getHostPlatformForAnalytics } from 'src/utils/env.js'
import { type CompletionType, logUnaryEvent } from 'src/services/api/unaryLogging.js'
import type { ToolUseConfirm } from 'src/components/permissions/PermissionRequest.js'

export function logUnaryPermissionEvent(
  completion_type: CompletionType,
  {
    assistantMessage: {
      message: { id: message_id },
    },
  }: ToolUseConfirm,
  event: 'accept' | 'reject',
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type,
    event,
    metadata: {
      language_name: 'none',
      message_id,
      platform: getHostPlatformForAnalytics(),
      hasFeedback: hasFeedback ?? false,
    },
  })
}
