import React from 'react'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { Box, Text } from 'src/terminal/ink.js'
import { shouldShowAlwaysAllowOptions } from 'src/permissions/permissionsLoader.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from 'src/permissions/ui/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'

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
  // Shared by Monitor and WaitFor — both delegate to the Bash rules — so the
  // label comes from the tool rather than a literal.
  const label = toolUseConfirm.tool.userFacingName(toolUseConfirm.input)

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
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      }
      case 'yes-dont-ask-again': {
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
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
      }
    }
  }

  const handleCancel = () => {
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
          <Text bold>{label}</Text> commands in{' '}
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
    toolName: toolUseConfirm.tool.name,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
  }

  return (
    <PermissionDialog title={label} workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {label}({command ?? ''})
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
