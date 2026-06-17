import { describe, expect, test } from 'bun:test'
import {
  getFocusedInputDialog,
  type FocusedInputDialogDeps,
} from './getFocusedInputDialog.js'

// Baseline deps: everything off, every queue empty, nothing pending.
// Each test overrides only the fields it cares about — this mirrors the
// behavior of REPL.tsx where most flags are false on a fresh prompt screen.
function baseDeps(): FocusedInputDialogDeps {
  return {
    isExiting: false,
    exitFlow: null,
    isMessageSelectorVisible: false,
    promptTypingSuppressionActive: false,
    sandboxPermissionRequestQueue: [],
    toolJSX: null,
    toolUseConfirmQueue: [],
    promptQueue: [],
    workerSandboxPermissions: { queue: [] },
    elicitation: { queue: [] },
    showingCostDialog: false,
    idleReturnPending: null,
    ultraplanPendingChoice: null,
    ultraplanLaunchPending: null,
    isLoading: false,
    showIdeOnboarding: false,
    showEffortCallout: false,
    showRemoteCallout: false,
    hintRecommendation: null,
    showDesktopUpsellStartup: false,
    startupChecksStarted: false,
  }
}

describe('getFocusedInputDialog', () => {
  test('returns undefined when nothing requests focus', () => {
    expect(getFocusedInputDialog(baseDeps())).toBeUndefined()
  })

  test('exit guards beat everything (isExiting)', () => {
    const d = baseDeps()
    d.isExiting = true
    d.isMessageSelectorVisible = true
    d.toolUseConfirmQueue = [{}]
    expect(getFocusedInputDialog(d)).toBeUndefined()
  })

  test('exit guards beat everything (exitFlow truthy)', () => {
    const d = baseDeps()
    d.exitFlow = {}
    d.isMessageSelectorVisible = true
    expect(getFocusedInputDialog(d)).toBeUndefined()
  })

  test('message selector wins over typing suppression', () => {
    const d = baseDeps()
    d.isMessageSelectorVisible = true
    d.promptTypingSuppressionActive = true
    d.toolUseConfirmQueue = [{}]
    expect(getFocusedInputDialog(d)).toBe('message-selector')
  })

  test('typing suppression hides sandbox dialog too (preserves original order)', () => {
    // The original code returns undefined for typing-suppression BEFORE
    // checking the sandbox queue (REPL.tsx:1817-1819). Preserved here so
    // extraction is behavior-identical.
    const d = baseDeps()
    d.promptTypingSuppressionActive = true
    d.sandboxPermissionRequestQueue = [{}]
    expect(getFocusedInputDialog(d)).toBeUndefined()
  })

  test('sandbox dialog wins when not typing-suppressed (over toolJSX-blocked)', () => {
    const d = baseDeps()
    d.sandboxPermissionRequestQueue = [{}]
    // Even with toolJSX set (which would block tool-permission etc.), sandbox
    // is allowed because the sandbox check sits above the toolJSX gate.
    d.toolJSX = {}
    expect(getFocusedInputDialog(d)).toBe('sandbox-permission')
  })

  test('typing suppression returns undefined when sandbox queue is empty', () => {
    const d = baseDeps()
    d.promptTypingSuppressionActive = true
    d.toolUseConfirmQueue = [{}]
    d.promptQueue = [{}]
    expect(getFocusedInputDialog(d)).toBeUndefined()
  })

  test('toolJSX without shouldContinueAnimation blocks permission dialogs', () => {
    const d = baseDeps()
    d.toolJSX = {}
    d.toolUseConfirmQueue = [{}]
    d.promptQueue = [{}]
    expect(getFocusedInputDialog(d)).toBeUndefined()
  })

  test('toolJSX with shouldContinueAnimation allows permission dialogs', () => {
    const d = baseDeps()
    d.toolJSX = { shouldContinueAnimation: true }
    d.toolUseConfirmQueue = [{}]
    expect(getFocusedInputDialog(d)).toBe('tool-permission')
  })

  test('priority: tool-permission > prompt > worker > elicitation > cost > idle', () => {
    const d = baseDeps()
    d.toolUseConfirmQueue = [{}]
    d.promptQueue = [{}]
    d.workerSandboxPermissions.queue = [{}]
    d.elicitation.queue = [{}]
    d.showingCostDialog = true
    d.idleReturnPending = {}
    expect(getFocusedInputDialog(d)).toBe('tool-permission')

    d.toolUseConfirmQueue = []
    expect(getFocusedInputDialog(d)).toBe('prompt')

    d.promptQueue = []
    expect(getFocusedInputDialog(d)).toBe('worker-sandbox-permission')

    d.workerSandboxPermissions.queue = []
    expect(getFocusedInputDialog(d)).toBe('elicitation')

    d.elicitation.queue = []
    expect(getFocusedInputDialog(d)).toBe('cost')

    d.showingCostDialog = false
    expect(getFocusedInputDialog(d)).toBe('idle-return')
  })

  test('onboarding/callout/recommendation order with startup gate', () => {
    const d = baseDeps()
    d.showIdeOnboarding = true
    d.showEffortCallout = true
    d.showRemoteCallout = true
    d.hintRecommendation = {}
    d.showDesktopUpsellStartup = true
    // startup gate off — low-priority dialogs suppressed
    expect(getFocusedInputDialog(d)).toBe('ide-onboarding')

    d.showIdeOnboarding = false
    expect(getFocusedInputDialog(d)).toBe('effort-callout')

    d.showEffortCallout = false
    expect(getFocusedInputDialog(d)).toBe('remote-callout')

    d.showRemoteCallout = false
    // lsp/hint/desktop still gated by startupChecksStarted
    expect(getFocusedInputDialog(d)).toBeUndefined()

    d.startupChecksStarted = true
    expect(getFocusedInputDialog(d)).toBe('plugin-hint')

    d.hintRecommendation = null
    expect(getFocusedInputDialog(d)).toBe('desktop-upsell')
  })
})
