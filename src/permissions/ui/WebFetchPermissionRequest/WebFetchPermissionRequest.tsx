import React, { useCallback, useMemo } from 'react'
import { Box, Text, useTheme } from 'src/terminal/ink.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'
import { shouldShowAlwaysAllowOptions } from 'src/permissions/permissionsLoader.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/select.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'
import { DontAskAgainLabel } from 'src/permissions/ui/toolDialogs/DontAskAgainLabel.js'
import { addAllowRule, fetchHost, fetchRule } from 'src/permissions/ui/toolDialogs/rules.js'

type Choice = 'yes' | 'yes-domain' | 'no'

const LOGGED = { completion_type: 'tool_use_single', language_name: 'none' } as const

/** The host of a URL the tool can read; `null` for input its schema refuses or a URL with no host. */
function readableHost(input: unknown): string | null {
  const parsed = WebFetchTool.inputSchema.safeParse(input)
  return parsed.success ? fetchHost(parsed.data.url) : null
}

/** `domainHost` is the host an allow-always would save, or `null` when none may be offered. */
function optionsFor(domainHost: string | null): OptionWithDescription<Choice>[] {
  const options: OptionWithDescription<Choice>[] = [{ value: 'yes', label: 'Yes' }]
  if (domainHost !== null) {
    options.push({ value: 'yes-domain', label: <DontAskAgainLabel subject={domainHost} inCwd={false} /> })
  }
  options.push({
    value: 'no',
    label: (
      <Text>
        No, and tell Claude what to do differently <Text bold>(esc)</Text>
      </Text>
    ),
  })
  return options
}

/**
 * Asks before a URL is fetched. A plain list, unlike the other tool dialogs:
 * no notes, and Esc is the No (spec Finding 5, kept). Allow-always saves the
 * exact host, and is not offered when the URL has no host to read.
 */
export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const { tool, input, description, permissionResult } = toolUseConfirm
  const [theme] = useTheme()
  usePermissionRequestLogging(toolUseConfirm, LOGGED)

  const host = shouldShowAlwaysAllowOptions() ? readableHost(input) : null
  const options = useMemo(() => optionsFor(host), [host])

  const reject = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onReject, onDone])

  const choose = useCallback(
    (choice: Choice) => {
      if (choice === 'no') return reject()
      const updates = choice === 'yes-domain' && host !== null ? [addAllowRule(fetchRule(tool.name, host))] : []
      toolUseConfirm.onAllow(input, updates)
      onDone()
    },
    [reject, host, tool.name, toolUseConfirm, input, onDone],
  )

  // The raw URL, whatever its shape: the dialog must open for input the tool's schema would refuse.
  const call = typeof input.url === 'string' ? WebFetchTool.renderToolUseMessage(input as { url: string }, { theme, verbose }) : null

  return (
    <PermissionDialog title="Fetch" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>{call}</Text>
        <Text dimColor>{description}</Text>
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
        <Text>Do you want to allow Claude to fetch this content?</Text>
        <Select options={options} onChange={choose} onCancel={reject} />
      </Box>
    </PermissionDialog>
  )
}
