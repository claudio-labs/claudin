import React, { useMemo } from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import { PermissionPrompt } from 'src/permissions/ui/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'
import { DontAskAgainLabel } from 'src/permissions/ui/toolDialogs/DontAskAgainLabel.js'
import { shellDelegateRule } from 'src/permissions/ui/toolDialogs/rules.js'
import { type AlwaysOption, useToolPrompt } from 'src/permissions/ui/toolDialogs/useToolPrompt.js'

const LOGGED = { completion_type: 'tool_use_single', language_name: 'none' } as const

const textField = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * The dialog of the tools that run a shell command under the Bash rules
 * (WaitFor, and Monitor in a build with it). Allow-always saves a Bash prefix
 * rule on the command alone; WaitFor's `setup` is not part of it.
 */
export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const { tool, input, permissionResult } = toolUseConfirm
  usePermissionRequestLogging(toolUseConfirm, LOGGED)

  const label = tool.userFacingName(input)
  const command = textField(input.command)
  const description = textField(input.description)

  const always = useMemo<AlwaysOption[]>(
    () => [{ value: 'yes-prefix', label: <DontAskAgainLabel subject={label} noun="commands" />, rule: shellDelegateRule(command) }],
    [label, command],
  )
  const prompt = useToolPrompt({ toolUseConfirm, onDone, onReject }, always)

  return (
    <PermissionDialog title={label} workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {label}({command})
        </Text>
        {description !== '' && <Text dimColor>{description}</Text>}
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
        <PermissionPrompt options={prompt.options} onSelect={prompt.onSelect} onCancel={prompt.onCancel} />
      </Box>
    </PermissionDialog>
  )
}
