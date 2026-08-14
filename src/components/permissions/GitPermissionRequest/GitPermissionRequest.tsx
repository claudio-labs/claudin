import React from 'react'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { Box, Text } from 'src/ink.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { shouldShowAlwaysAllowOptions } from 'src/services/permissions/permissionsLoader.js'
import type { PermissionUpdate } from 'src/services/permissions/PermissionUpdateSchema.js'
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

const WHITESPACE_RE = /\s+/

/**
 * `git push origin main` → `git push`. Same two-token shape BashTool's rule
 * suggestions use, so a rule saved here is indistinguishable from one saved
 * from a Bash prompt.
 */
function rulePrefix(command: string): string {
  return command.trim().split(WHITESPACE_RE).slice(0, 2).join(' ')
}

/**
 * Permission dialog for the Git tool.
 *
 * Exists for one reason: `FallbackPermissionRequest`'s "don't ask again" saves
 * a rule with no `ruleContent` — `{ toolName: 'Git' }` — which would grant the
 * ENTIRE tool, `git push --force` included, from a single keystroke on a `git
 * status` prompt. Since `checkPermissions` delegates to
 * `bashToolHasPermission`, a `Git(...)` rule would also never be consulted
 * again; the rules that matter are `Bash(...)`-shaped.
 *
 * So this dialog saves one `Bash(<binary> <subcommand>:*)` rule per distinct
 * command in the batch, which is exactly what the Bash dialog would have saved
 * for the same commands. `MonitorPermissionRequest` solves the same problem the
 * same way.
 */
export function GitPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps) {
  const { commands } = toolUseConfirm.input as { commands?: string[] }
  const list = commands ?? []

  usePermissionRequestLogging(toolUseConfirm, {
    completion_type: 'tool_use_single',
    language_name: 'none',
  })

  const prefixes = [...new Set(list.map(rulePrefix).filter(Boolean))]

  const handleSelect = (value: OptionValue, feedback?: string) => {
    switch (value) {
      case 'yes': {
        logUnaryPermissionEvent(
          'tool_use_single',
          toolUseConfirm,
          'accept',
          Boolean(feedback),
        )
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      }
      case 'yes-dont-ask-again': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept')
        const updates: PermissionUpdate[] =
          prefixes.length > 0
            ? [
                {
                  type: 'addRules',
                  rules: prefixes.map(prefix => ({
                    toolName: 'Bash',
                    ruleContent: `${prefix}:*`,
                  })),
                  behavior: 'allow',
                  destination: 'localSettings',
                },
              ]
            : []
        toolUseConfirm.onAllow(toolUseConfirm.input, updates)
        onDone()
        break
      }
      case 'no': {
        logUnaryPermissionEvent(
          'tool_use_single',
          toolUseConfirm,
          'reject',
          Boolean(feedback),
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

  const options: PermissionPromptOption<OptionValue>[] = [
    { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
  ]

  if (shouldShowAlwaysAllowOptions() && prefixes.length > 0) {
    options.push({
      label: (
        <Text>
          Yes, and don&apos;t ask again for{' '}
          <Text bold>{prefixes.join(', ')}</Text> commands in{' '}
          <Text bold>{getOriginalCwd()}</Text>
        </Text>
      ),
      value: 'yes-dont-ask-again',
    })
  }

  options.push({ label: 'No', value: 'no', feedbackConfig: { type: 'reject' } })

  return (
    <PermissionDialog title="Git" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {list.map(command => (
          <Text key={command}>{command}</Text>
        ))}
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
          toolAnalyticsContext={{
            toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
            isMcp: toolUseConfirm.tool.isMcp ?? false,
          }}
        />
      </Box>
    </PermissionDialog>
  )
}
