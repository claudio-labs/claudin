import React, { useMemo } from 'react'
import { Box, Text, useTheme } from 'src/terminal/ink.js'
import { truncateToLines } from 'src/shared/text/stringUtils.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import { PermissionPrompt } from 'src/permissions/ui/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'
import { DontAskAgainLabel } from 'src/permissions/ui/toolDialogs/DontAskAgainLabel.js'
import { wholeToolRule } from 'src/permissions/ui/toolDialogs/rules.js'
import { type AlwaysOption, useToolPrompt } from 'src/permissions/ui/toolDialogs/useToolPrompt.js'

const MCP_SUFFIX = ' (MCP)'
const DESCRIPTION_LINES = 3
const LOGGED = { completion_type: 'tool_use_single', language_name: 'none' } as const

/** The name shown for the tool, and whether an MCP marker was taken off its end. */
function splitMcpSuffix(shownName: string): { name: string; isMcp: boolean } {
  return shownName.endsWith(MCP_SUFFIX)
    ? { name: shownName.slice(0, -MCP_SUFFIX.length), isMcp: true }
    : { name: shownName, isMcp: false }
}

/** The dialog for any tool without one of its own: the call, then Yes / allow the whole tool / No. */
export function FallbackPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, workerBadge } = props
  const { tool, input, description, permissionResult } = toolUseConfirm
  const [theme] = useTheme()
  usePermissionRequestLogging(toolUseConfirm, LOGGED)

  const { name, isMcp } = splitMcpSuffix(tool.userFacingName(input))

  const always = useMemo<AlwaysOption[]>(
    () => [{ value: 'yes-tool', label: <DontAskAgainLabel subject={name} noun="commands" />, rule: wholeToolRule(tool.name) }],
    [name, tool.name],
  )
  const prompt = useToolPrompt(props, always)

  return (
    <PermissionDialog title="Tool use" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {name}({tool.renderToolUseMessage(input, { theme, verbose: true })})
          {isMcp && <Text dimColor>{MCP_SUFFIX}</Text>}
        </Text>
        <Text dimColor>{truncateToLines(description, DESCRIPTION_LINES)}</Text>
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
        <PermissionPrompt options={prompt.options} onSelect={prompt.onSelect} onCancel={prompt.onCancel} />
      </Box>
    </PermissionDialog>
  )
}
