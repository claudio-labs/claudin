import React from 'react'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { Box, Text } from 'src/ink.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { shouldShowAlwaysAllowOptions } from 'src/services/permissions/permissionsLoader.js'
import { usePermissionRequestLogging } from 'src/components/permissions/hooks.js'
import { PermissionDialog } from 'src/components/permissions/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from 'src/components/permissions/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/components/permissions/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/components/permissions/PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from 'src/components/permissions/utils.js'

type OptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps) {
  const { command, description } = toolUseConfirm.input as {
    command?: string
    description?: string
  }

  usePermissionRequestLogging(toolUseConfirm, {
    completion_type: 'tool_use_single',
    language_name: 'none',
  })

  const handleSelect = (
    value: OptionValue,
    feedback?: string,
  ) => {
    switch (value) {
      case 'yes': {
        logUnaryPermissionEvent(
          'tool_use_single',
          toolUseConfirm,
          'accept',
          !!feedback,
        )
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      }
      case 'yes-dont-ask-again': {
        logUnaryPermissionEvent(
          'tool_use_single',
          toolUseConfirm,
          'accept',
          !!feedback,
        )
        // Save the rule under 'Bash' toolName because checkPermissions
        // delegates to bashToolHasPermission which matches rules against
        // BashTool. Using 'Monitor' here would create a rule that's never
        // checked. Command-specific prefix (like BashTool's shellRuleMatching).
        const cmdForRule = command?.trim() || ''
        const prefix = cmdForRule.split(/\s+/).slice(0, 2).join(' ')
        toolUseConfirm.onAllow(toolUseConfirm.input, prefix ? [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: `${prefix}:*` }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ] : [])
        onDone()
        break
      }
      case 'no': {
        logUnaryPermissionEvent(
          'tool_use_single',
          toolUseConfirm,
          'reject',
          !!feedback,
        )
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
      }
    }
  }

  const handleCancel = () => {
    logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject')
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }

  const showAlwaysAllow = shouldShowAlwaysAllowOptions()
  const originalCwd = getOriginalCwd()

  const options: PermissionPromptOption<OptionValue>[] = [
    {
      label: 'Yes',
      value: 'yes',
      feedbackConfig: { type: 'accept' },
    },
  ]

  if (showAlwaysAllow) {
    options.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for{' '}
          <Text bold>Monitor</Text> commands in{' '}
          <Text bold>{originalCwd}</Text>
        </Text>
      ),
      value: 'yes-dont-ask-again',
    })
  }

  options.push({
    label: 'No',
    value: 'no',
    feedbackConfig: { type: 'reject' },
  })

  const toolAnalyticsContext = {
    toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
    isMcp: toolUseConfirm.tool.isMcp ?? false,
  }

  return (
    <PermissionDialog title="Monitor" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          Monitor({command ?? ''})
        </Text>
        {description ? (
          <Text dimColor>{description}</Text>
        ) : null}
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}
