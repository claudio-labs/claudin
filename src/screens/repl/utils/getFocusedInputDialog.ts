// Pure resolver for "which dialog currently owns input focus?".
//
// Extracted from src/screens/REPL.tsx (Etapa 2, ROADMAP 11e). The original
// was a nested function inside the REPL component closure, recomputed on every
// render via implicit capture of ~20 pieces of local state. Pulling it out as
// a pure function:
//   1. Documents the inputs that drive focus arbitration in one place.
//   2. Makes the priority order independently testable (see .test.ts).
//   3. Keeps zero behavior change — call sites still pass the same values in
//      the same order; the return type matches the original union literal.
//
// Not a React hook: this function has no state of its own and is intentionally
// callable mid-render (it reads the current snapshot to decide what to show).

import { feature } from 'bun:bundle'

export type FocusedInputDialog =
  | 'message-selector'
  | 'sandbox-permission'
  | 'tool-permission'
  | 'prompt'
  | 'worker-sandbox-permission'
  | 'elicitation'
  | 'cost'
  | 'idle-return'
  | 'init-onboarding'
  | 'ide-onboarding'
  | 'model-switch'
  | 'effort-callout'
  | 'remote-callout'
  | 'lsp-recommendation'
  | 'plugin-hint'
  | 'desktop-upsell'
  | 'ultraplan-choice'
  | 'ultraplan-launch'

// Minimal shape for `toolJSX`. Only the focus-arbitration flag matters here;
// REPL.tsx's full type carries additional render fields we don't need.
export type ToolJSXFocusInput = {
  shouldContinueAnimation?: true
} | null | undefined

export type FocusedInputDialogDeps = {
  // Hard precedence: exiting overrides everything.
  isExiting: boolean
  exitFlow: unknown
  // Message selector — always wins after exit guards.
  isMessageSelectorVisible: boolean
  // While the user types, suppress interrupt-style permission dialogs.
  promptTypingSuppressionActive: boolean
  // Sandbox-network permission requests bypass typing suppression.
  sandboxPermissionRequestQueue: ReadonlyArray<unknown>
  // The remaining permission/interactive dialogs only show if toolJSX is
  // absent OR has opted in via shouldContinueAnimation.
  toolJSX: ToolJSXFocusInput
  toolUseConfirmQueue: ReadonlyArray<unknown>
  promptQueue: ReadonlyArray<unknown>
  workerSandboxPermissions: { queue: ReadonlyArray<unknown> }
  elicitation: { queue: ReadonlyArray<unknown> }
  showingCostDialog: boolean
  idleReturnPending: unknown
  ultraplanPendingChoice: unknown
  ultraplanLaunchPending: unknown
  isLoading: boolean
  showIdeOnboarding: boolean
  showEffortCallout: boolean
  showRemoteCallout: boolean
  lspRecommendation: unknown
  hintRecommendation: unknown
  showDesktopUpsellStartup: boolean
  // Startup gate for the low-priority suggestion dialogs (issue #363).
  startupChecksStarted: boolean
}

export function getFocusedInputDialog(
  d: FocusedInputDialogDeps,
): FocusedInputDialog | undefined {
  // Exit states always take precedence.
  if (d.isExiting || d.exitFlow) return undefined

  // High priority dialogs (always show regardless of typing).
  if (d.isMessageSelectorVisible) return 'message-selector'

  // Suppress interrupt dialogs while user is actively typing.
  if (d.promptTypingSuppressionActive) return undefined
  if (d.sandboxPermissionRequestQueue[0]) return 'sandbox-permission'

  // Permission/interactive dialogs (show unless blocked by toolJSX).
  const allowDialogsWithAnimation = !d.toolJSX || d.toolJSX.shouldContinueAnimation
  if (allowDialogsWithAnimation && d.toolUseConfirmQueue[0]) return 'tool-permission'
  if (allowDialogsWithAnimation && d.promptQueue[0]) return 'prompt'
  // Worker sandbox permission prompts (network access) from swarm workers.
  if (allowDialogsWithAnimation && d.workerSandboxPermissions.queue[0]) return 'worker-sandbox-permission'
  if (allowDialogsWithAnimation && d.elicitation.queue[0]) return 'elicitation'
  if (allowDialogsWithAnimation && d.showingCostDialog) return 'cost'
  if (allowDialogsWithAnimation && d.idleReturnPending) return 'idle-return'
  if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !d.isLoading && d.ultraplanPendingChoice) return 'ultraplan-choice'
  if (feature('ULTRAPLAN') && allowDialogsWithAnimation && !d.isLoading && d.ultraplanLaunchPending) return 'ultraplan-launch'

  // Onboarding dialogs (special conditions).
  if (allowDialogsWithAnimation && d.showIdeOnboarding) return 'ide-onboarding'

  // Effort callout (shown once for Opus 4.6/4.7 users when effort is enabled).
  if (allowDialogsWithAnimation && d.showEffortCallout) return 'effort-callout'

  // Remote callout (shown once before first bridge enable).
  if (allowDialogsWithAnimation && d.showRemoteCallout) return 'remote-callout'

  // LSP plugin recommendation (lowest priority - non-blocking suggestion).
  // Suppress during startup window to prevent stealing focus from the prompt (issue #363).
  if (allowDialogsWithAnimation && d.lspRecommendation && d.startupChecksStarted) return 'lsp-recommendation'

  // Plugin hint from CLI/SDK stderr (same priority band as LSP rec).
  if (allowDialogsWithAnimation && d.hintRecommendation && d.startupChecksStarted) return 'plugin-hint'

  // Desktop app upsell (max 3 launches, lowest priority).
  if (allowDialogsWithAnimation && d.showDesktopUpsellStartup && d.startupChecksStarted) return 'desktop-upsell'
  return undefined
}
