import React, { useCallback, useState } from 'react'

import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { AutoModeRules } from 'src/permissions/yoloClassifier.js'
import { getAutoModeConfig } from 'src/platform/settings/settings.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import {
  type ProposedRules,
  proposeRules,
} from 'src/commands/auto-mode-setup/analyzeRules.js'
import {
  type SectionDiff,
  applyRules,
  diffRules,
  enableAutoMode,
  isNoOpDiff,
} from 'src/commands/auto-mode-setup/applyRules.js'
import { collectSignals } from 'src/commands/auto-mode-setup/collectSignals.js'
import {
  type ScanStep,
  ScanProgress,
} from 'src/commands/auto-mode-setup/ScanProgress.js'
import {
  type WizardChoice,
  SetupWizard,
} from 'src/commands/auto-mode-setup/SetupWizard.js'
import { ReviewRules } from 'src/commands/auto-mode-setup/ReviewRules.js'
import {
  type EnableChoice,
  EnableAutoMode,
} from 'src/commands/auto-mode-setup/EnableAutoMode.js'

type Phase =
  | { kind: 'wizard' }
  | { kind: 'scanning'; steps: ScanStep[] }
  | { kind: 'review'; proposal: ProposedRules; diff: SectionDiff[] }
  | { kind: 'enable' }

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
): Promise<React.ReactNode> {
  return <AutoModeSetup onDone={onDone} context={context} />
}

function AutoModeSetup({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: ToolUseContext
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'wizard' })
  const [proposal, setProposal] = useState<ProposedRules | null>(null)

  const handleCancel = useCallback(() => {
    onDone('Cancelled — nothing was written.')
  }, [onDone])

  const handleWizard = useCallback(
    (choice: WizardChoice) => {
      const steps: ScanStep[] = [
        { label: 'Reading this project', status: 'running' },
        { label: 'Reading recent sessions', status: 'pending' },
        {
          label: 'Reading shell history',
          status: choice.includeShellHistory ? 'pending' : 'skipped',
        },
        { label: 'Proposing rules', status: 'pending' },
      ]
      setPhase({ kind: 'scanning', steps })

      void runScan(choice, context, steps, setPhase)
        .then(result => {
          if (result.kind === 'failed') {
            onDone(result.message)
            return
          }
          setProposal(result.proposal)
          setPhase({ kind: 'review', proposal: result.proposal, diff: result.diff })
        })
        .catch((error: unknown) => {
          logError(error)
          onDone(`Auto mode setup failed: ${errorMessage(error)}`)
        })
    },
    [context, onDone],
  )

  const handleAccept = useCallback(() => {
    if (!proposal) return
    const { error } = applyRules(proposal)
    if (error) {
      onDone(`Could not write the rules: ${errorMessage(error)}`)
      return
    }
    setPhase({ kind: 'enable' })
  }, [onDone, proposal])

  const handleEnable = useCallback(
    (choice: EnableChoice) => {
      if (choice === 'skip') {
        onDone('Auto mode rules saved to your user settings.')
        return
      }
      const { error } = enableAutoMode(choice === 'enable-default')
      if (error) {
        onDone(`Rules saved, but auto mode could not be enabled: ${errorMessage(error)}`)
        return
      }
      onDone(
        choice === 'enable-default'
          ? 'Auto mode rules saved. Auto mode is now your default permission mode.'
          : 'Auto mode rules saved. Auto mode is enabled — shift+tab to change mode.',
      )
    },
    [onDone],
  )

  switch (phase.kind) {
    case 'wizard':
      return <SetupWizard onSubmit={handleWizard} onCancel={handleCancel} />
    case 'scanning':
      return <ScanProgress steps={phase.steps} onCancel={handleCancel} />
    case 'review':
      return (
        <ReviewRules
          diff={phase.diff}
          notes={phase.proposal.notes}
          onAccept={handleAccept}
          onCancel={handleCancel}
        />
      )
    case 'enable':
      return <EnableAutoMode onChoose={handleEnable} />
  }
}

type ScanResult =
  | { kind: 'proposed'; proposal: ProposedRules; diff: SectionDiff[] }
  | { kind: 'failed'; message: string }

async function runScan(
  choice: WizardChoice,
  context: ToolUseContext,
  steps: ScanStep[],
  setPhase: (phase: Phase) => void,
): Promise<ScanResult> {
  const advance = (index: number): void => {
    const next = steps.map((step, i) => {
      if (step.status === 'skipped') return step
      if (i < index) return { ...step, status: 'done' as const }
      if (i === index) return { ...step, status: 'running' as const }
      return step
    })
    steps = next
    setPhase({ kind: 'scanning', steps: next })
  }

  const permissionsAllow = Object.values(
    context.getAppState().toolPermissionContext.alwaysAllowRules,
  ).flat()

  advance(1)
  const signals = await collectSignals({
    posture: choice.posture,
    includeShellHistory: choice.includeShellHistory,
    permissionsAllow,
  })

  advance(3)
  const current = toAutoModeRules(getAutoModeConfig())
  const proposal = await proposeRules(signals, current, {
    signal: context.abortController.signal,
  })

  const diff = diffRules(current, proposal)
  if (isNoOpDiff(diff)) {
    return {
      kind: 'failed',
      message: 'Your auto mode rules already match this environment — nothing to change.',
    }
  }
  return { kind: 'proposed', proposal, diff }
}

function toAutoModeRules(
  config: { allow?: string[]; soft_deny?: string[]; environment?: string[] } | undefined,
): AutoModeRules | null {
  if (!config) return null
  return {
    allow: config.allow ?? [],
    soft_deny: config.soft_deny ?? [],
    environment: config.environment ?? [],
  }
}
