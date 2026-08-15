import { getHostPlatformForAnalytics } from 'src/shared/env.js'
import { type CompletionType, logUnaryEvent } from 'src/providers/transport/unaryLogging.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'

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
