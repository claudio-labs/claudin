/**
 * The options and answers shared by the tool dialogs drawn with
 * `PermissionPrompt` (tool-wide, skill, shell delegate). They differ only in
 * which allow-always options they offer and the rule each one saves.
 */
import { type ReactNode, useCallback, useMemo } from 'react'
import { shouldShowAlwaysAllowOptions } from 'src/permissions/permissionsLoader.js'
import type { PermissionPromptOption } from 'src/permissions/ui/PermissionPrompt.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import type { PermissionRuleValue } from 'src/shared/types/permissions.js'
import { addAllowRule } from 'src/permissions/ui/toolDialogs/rules.js'

const YES = 'yes'
const NO = 'no'
// One empty list, so a policy that withholds the options keeps the option list stable across renders.
const NONE: readonly AlwaysOption[] = []

export type AlwaysOption = {
  value: string
  label: ReactNode
  /** `null` allows without saving anything (the shell delegate's wordless command). */
  rule: PermissionRuleValue | null
}

type Answers = Pick<PermissionRequestProps, 'toolUseConfirm' | 'onDone' | 'onReject'>

export type ToolPrompt = {
  options: PermissionPromptOption<string>[]
  onSelect: (value: string, note?: string) => void
  onCancel: () => void
}

/**
 * Yes, the allow-always options policy permits, then No. Yes and No take a
 * note; an allow-always never does.
 */
export function useToolPrompt({ toolUseConfirm, onDone, onReject }: Answers, always: readonly AlwaysOption[]): ToolPrompt {
  const offered = shouldShowAlwaysAllowOptions() ? always : NONE

  const options = useMemo<PermissionPromptOption<string>[]>(
    () => [
      { value: YES, label: 'Yes', feedbackConfig: { type: 'accept' } },
      ...offered.map(option => ({ value: option.value, label: option.label })),
      { value: NO, label: 'No', feedbackConfig: { type: 'reject' } },
    ],
    [offered],
  )

  const onSelect = useCallback(
    (value: string, note?: string) => {
      if (value === NO) {
        toolUseConfirm.onReject(note)
        onReject()
        onDone()
        return
      }
      if (value === YES) {
        toolUseConfirm.onAllow(toolUseConfirm.input, [], note)
        onDone()
        return
      }
      const chosen = offered.find(option => option.value === value)
      if (!chosen) return
      toolUseConfirm.onAllow(toolUseConfirm.input, chosen.rule ? [addAllowRule(chosen.rule)] : [])
      onDone()
    },
    [toolUseConfirm, onDone, onReject, offered],
  )

  const onCancel = useCallback(() => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onDone, onReject])

  return { options, onSelect, onCancel }
}
