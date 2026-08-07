// Reconstructed from its use sites — the original module was not carried into
// this fork. Shapes come from the context object built in `WizardProvider.tsx`
// and the props it destructures.
import type { ComponentType, ReactNode } from 'react'

/**
 * A wizard step. `WizardProvider` renders it as `<CurrentStepComponent />`, so
 * it takes no props — steps read and write shared state through `useWizard()`.
 */
export type WizardStepComponent = ComponentType

export type WizardContextValue<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  setWizardData: (updater: T | ((previous: T) => T)) => void
  /** Shallow-merges `updates` into the accumulated wizard data. */
  updateWizardData: (updates: Partial<T>) => void
  /** Advances one step, or completes the wizard on the last one. */
  goNext: () => void
  /** Pops the navigation history, else steps back, else cancels. */
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  title?: string
  showStepCounter: boolean
}

export type WizardProviderProps<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  steps: WizardStepComponent[]
  /** Defaults to `{}` when omitted. */
  initialData?: T
  onComplete: (data: T) => void
  onCancel?: () => void
  /** Rendered instead of the current step when provided. */
  children?: ReactNode
  title?: string
  /** Defaults to `true`. */
  showStepCounter?: boolean
}
