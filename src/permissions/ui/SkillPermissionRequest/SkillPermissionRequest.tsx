import React, { useMemo } from 'react'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { logError } from 'src/shared/log.js'
import { Box, Text } from 'src/terminal/ink.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { usePermissionRequestLogging } from 'src/permissions/ui/hooks.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import { PermissionPrompt } from 'src/permissions/ui/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import { PermissionRuleExplanation } from 'src/permissions/ui/PermissionRuleExplanation.js'
import { DontAskAgainLabel } from 'src/permissions/ui/toolDialogs/DontAskAgainLabel.js'
import { skillRule, skillRuleContents } from 'src/permissions/ui/toolDialogs/rules.js'
import { type AlwaysOption, useToolPrompt } from 'src/permissions/ui/toolDialogs/useToolPrompt.js'

const LOGGED = { completion_type: 'tool_use_single', language_name: 'none' } as const

/** The skill the input names, as SkillTool reads it; empty when it cannot read the input. */
function skillNameOf(input: unknown): string {
  const parsed = SkillTool.inputSchema.safeParse(input)
  if (parsed.success) return parsed.data.skill
  logError(new Error(`SkillPermissionRequest: unreadable Skill input: ${parsed.error.message}`))
  return ''
}

/** The command's description, only when the check asked and found the command. */
function commandDescriptionOf(result: PermissionDecision): string | undefined {
  if (result.behavior !== 'ask') return undefined
  const metadata = (result as { metadata?: { command?: { description?: unknown } } }).metadata
  const description = metadata?.command?.description
  return typeof description === 'string' && description !== '' ? description : undefined
}

/** Unreadable input names no skill, so it is offered no allow-always option at all. */
function alwaysOptionsFor(skill: string): AlwaysOption[] {
  const contents = skillRuleContents(skill)
  if (!contents) return []
  const options: AlwaysOption[] = [
    { value: 'yes-exact', label: <DontAskAgainLabel subject={contents.exact} />, rule: skillRule(contents.exact) },
  ]
  if (contents.prefix !== null) {
    options.push({
      value: 'yes-prefix',
      label: <DontAskAgainLabel subject={contents.prefix} noun="commands" />,
      rule: skillRule(contents.prefix),
    })
  }
  return options
}

/** Asks before a skill runs; allow-always saves the exact skill or, for a name with a space, its first word as a prefix. */
export function SkillPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, workerBadge } = props
  const { input, permissionResult } = toolUseConfirm
  usePermissionRequestLogging(toolUseConfirm, LOGGED)

  const skill = useMemo(() => skillNameOf(input), [input])
  const always = useMemo(() => alwaysOptionsFor(skill), [skill])
  const prompt = useToolPrompt(props, always)
  const description = commandDescriptionOf(permissionResult)

  return (
    <PermissionDialog title={`Use skill "${skill}"?`} workerBadge={workerBadge}>
      <Text>Claude may use instructions, code, or files from this Skill.</Text>
      {description !== undefined && (
        <Box paddingX={2}>
          <Text dimColor>{description}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <PermissionRuleExplanation permissionResult={permissionResult} toolType="tool" />
        <PermissionPrompt options={prompt.options} onSelect={prompt.onSelect} onCancel={prompt.onCancel} />
      </Box>
    </PermissionDialog>
  )
}
