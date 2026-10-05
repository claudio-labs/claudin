import React from 'react'
import { handlePlanModeTransition } from 'src/platform/bootstrap/state.js'
import { Box, Text } from 'src/terminal/ink.js'
import { type AppState, useAppState } from 'src/terminal/state/AppState.js'
import { Select } from 'src/terminal/custom-select/index.js'
import { PermissionDialog } from 'src/permissions/ui/PermissionDialog.js'
import type { PermissionRequestProps } from 'src/permissions/ui/PermissionRequest.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'

type Answer = 'enter' | 'stay'

const ANSWERS: Array<{ label: string; value: Answer }> = [
  { label: 'Yes, enter plan mode', value: 'enter' },
  { label: 'No, start implementing now', value: 'stay' },
]

const PLAN_MODE_STEPS = [
  'Explore the codebase thoroughly',
  'Identify existing patterns',
  'Design an implementation strategy',
  'Present a plan for your approval',
]

/** Session-scoped: entering plan mode is never written to a settings file. */
const ENTER_PLAN: PermissionUpdate[] = [{ type: 'setMode', mode: 'plan', destination: 'session' }]

const currentMode = (state: AppState) => state.toolPermissionContext.mode

export function EnterPlanModePermissionRequest({ toolUseConfirm, onDone, onReject, workerBadge }: PermissionRequestProps) {
  const mode = useAppState(currentMode)

  const enter = () => {
    // Withdraws a plan-exit notice still waiting to be sent; the mode itself
    // is changed by whoever applies the update.
    handlePlanModeTransition(mode, 'plan')
    onDone()
    toolUseConfirm.onAllow({}, ENTER_PLAN)
  }
  const stay = () => {
    onDone()
    onReject()
    toolUseConfirm.onReject()
  }

  return (
    <PermissionDialog color="planMode" title="Enter plan mode?" workerBadge={workerBadge}>
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Text>Claude wants to enter plan mode to explore and design an implementation approach.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>In plan mode, Claude will:</Text>
          {PLAN_MODE_STEPS.map(step => (
            <Text key={step} dimColor>
              {' '}· {step}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>No code changes will be made until you approve the plan.</Text>
        </Box>
        <Box marginTop={1}>
          <Select options={ANSWERS} onChange={value => (value === 'enter' ? enter() : stay())} onCancel={stay} />
        </Box>
      </Box>
    </PermissionDialog>
  )
}
