// Modal-dialog cluster rendered inside the main REPL bottom-pane column,
// extracted from `src/screens/REPL.tsx` in Etapa 5 of ROADMAP 11e.
//
// SHAPE: this module exports a *render function*, not a React component.
// The plan calls out (risk table) that the dialog block is the most
// closure-heavy section in REPL — every dialog inlines its own onDone /
// onResponse / onCancel handler that reaches into ~60 setters, refs and
// helpers. Wrapping that in a memoised component would either:
//
//   1. force a fresh `DialogDeps` object on every parent render (memo
//      busted, identity churn equal to inlining — but with a new fiber
//      boundary the React reconciler has to walk through), or
//   2. require manual memoisation of the deps bag and individual
//      callbacks, which is exactly the kind of subtle dependency-array
//      mistake that breaks dialogs when a setter captures stale state.
//
// A plain render function (`renderREPLDialogs(deps)`) sidesteps both:
// the JSX it produces is woven directly into REPL's render output, so
// React sees the *same* fiber tree and the *same* inline callbacks
// reconstructed at the same point in the render cycle as before the
// extraction. The only thing that changes is the line of code that
// produces them — the runtime behaviour, hook ordering and identity
// guarantees are untouched.
//
// All references to setters / refs / helpers come from the `deps` bag.
// We never destructure at the top to avoid the closure-capture footgun
// (a later code edit could accidentally read from a stale local instead
// of the bag); every callback uses `deps.fooSetter` directly. That is
// also why every field on `DialogDeps` is typed broadly (`unknown` or
// minimal shapes): the canonical signatures live in REPL.tsx and would
// have to be re-asserted here. The plan's deliberate scope cap (no
// controller extraction) means this duplication is short-lived.

import * as React from 'react'
import { feature } from 'bun:bundle'
import { saveGlobalConfig } from 'src/utils/config.js'
import { logEvent } from 'src/services/analytics/index.js'
import { logError } from 'src/utils/log.js'
import { CostThresholdDialog } from 'src/components/CostThresholdDialog.js'
import { IdleReturnDialog } from 'src/components/IdleReturnDialog.js'
import { ElicitationDialog } from 'src/components/mcp/ElicitationDialog.js'
import { PromptDialog } from 'src/components/hooks/PromptDialog.js'
import { WorkerPendingPermission } from 'src/components/permissions/WorkerPendingPermission.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { applyPermissionUpdate, persistPermissionUpdate } from 'src/utils/permissions/PermissionUpdate.js'
import {
  sendSandboxPermissionResponseViaMailbox,
} from 'src/utils/swarm/permissionSync.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'

export type REPLDialogsDeps = {
  // gating
  focusedInputDialog: string | undefined
  // sandbox permission (in-process)
  sandboxPermissionRequestQueue: Array<{
    hostPattern: { host: string; port?: number }
    resolvePromise: (allow: boolean) => void
  }>
  setSandboxPermissionRequestQueue: React.Dispatch<React.SetStateAction<unknown[]>>
  sandboxBridgeCleanupRef: React.RefObject<Map<string, Array<() => void>>>
  // prompts (hooks)
  promptQueue: Array<{
    title: string
    toolInputSummary: unknown
    request: { prompt: string }
    resolve: (response: { prompt_response: string; selected: unknown }) => void
    reject: (e: Error) => void
  }>
  setPromptQueue: React.Dispatch<React.SetStateAction<unknown[]>>
  // worker / pending indicators
  pendingWorkerRequest: { toolName: string; description: string } | null
  pendingSandboxRequest: { host: string } | null
  // worker sandbox queue
  workerSandboxPermissions: {
    queue: Array<{ requestId: string; host: string; workerName: string }>
  }
  teamContext: { teamName?: string } | undefined
  // app state
  setAppState: (updater: (prev: unknown) => unknown) => void
  // elicitation
  elicitation: {
    queue: Array<{
      serverName: string
      requestId: string
      params: { mode?: string }
      respond: (r: { action: unknown; content: unknown }) => void
      onWaitingDismiss?: (action: unknown) => void
    }>
  }
  // cost
  setShowCostDialog: (v: boolean) => void
  setHaveShownCostDialog: (v: boolean) => void
  // idle-return
  idleReturnPending: { idleMinutes: number; input: string } | null
  setIdleReturnPending: (v: null) => void
  getTotalInputTokens: () => number
  messagesRef: React.RefObject<unknown[]>
  setInputValue: (v: string) => void
  // clear-conversation deps
  setMessages: (m: unknown) => void
  readFileState: React.RefObject<unknown>
  discoveredSkillNamesRef: React.RefObject<unknown>
  loadedNestedMemoryPathsRef: React.RefObject<unknown>
  store: { getState: () => unknown }
  setConversationId: (id: string) => void
  haikuTitleAttemptedRef: React.RefObject<boolean>
  setHaikuTitle: (v: undefined) => void
  bashTools: React.RefObject<{ clear: () => void }>
  bashToolsProcessedIdx: React.RefObject<number>
  skipIdleCheckRef: React.RefObject<boolean>
  onSubmitRef: React.RefObject<(input: string, helpers: { setCursorOffset: () => void; clearBuffer: () => void; resetHistory: () => void }) => unknown>
  // IDE onboarding
  setShowIdeOnboarding: (v: boolean) => void
  ideInstallationStatus: unknown
  // effort callout
  mainLoopModel: unknown
  setShowEffortCallout: (v: boolean) => void
  // remote callout — none beyond setAppState
  // exit flow
  exitFlow: React.ReactNode
  // plugin / lsp / desktop
  hintRecommendation: {
    pluginName: string
    pluginDescription: string
    marketplaceName: string
    sourceCommand: string
  } | null
  handleHintResponse: (response: unknown) => void
  setShowDesktopUpsellStartup: (v: boolean) => void
  // ultraplan
  ultraplanPendingChoice: {
    plan: unknown
    sessionId: string
    taskId: string
  } | null
  ultraplanLaunchPending: { blurb: string } | null
  queryGuard: { isActive: boolean; subscribe: (cb: () => void) => () => void }
  createAbortController: () => AbortController
  // Ultraplan launch helpers
  createCommandInputMessage: (text: string) => unknown
  formatCommandInputTags: (cmd: string, blurb: string) => string
  escapeXml: (s: string) => string
  LOCAL_COMMAND_STDOUT_TAG: string
  launchUltraplan: (opts: {
    blurb: string
    getAppState: () => unknown
    setAppState: (updater: (prev: unknown) => unknown) => void
    signal: AbortSignal
    disconnectedBridge: unknown
    onSessionReady: (msg: string) => void
  }) => Promise<string>
  // ultraplan-launch optional ultraplanSessionUrl read via store.getState()
}

// PluginHintMenu / DesktopUpsellStartup /
// EffortCallout / RemoteCallout / IdeOnboardingDialog /
// SandboxPermissionRequest / UltraplanChoiceDialog / UltraplanLaunchDialog
// are imported lazily by REPL when feature flags require — to keep the
// extracted block faithful we accept the rendered slot as a ReactNode
// or accept the components themselves via the deps. We import the
// always-on ones above; the rest come from REPL via dedicated slot
// props so this module never has to know about feature gates.
export type REPLDialogsSlots = {
  // Components passed in so REPL keeps ownership of any feature() gating
  // and conditional require()s. Each slot is invoked here with the right
  // props inside the conditional render — REPL never has to thread its
  // own ad-hoc JSX in.
  SandboxPermissionRequest: React.ComponentType<{
    key?: string
    hostPattern: { host: string; port?: number }
    onUserResponse: (r: { allow: boolean; persistToSettings: boolean }) => void
  }>
  IdeOnboardingDialog: React.ComponentType<{ onDone: () => void; installationStatus: unknown }>
  EffortCallout: React.ComponentType<{ model: unknown; onDone: (selection: string) => void }>
  RemoteCallout: React.ComponentType<{ onDone: (selection: string) => void }>
  PluginHintMenu: React.ComponentType<{
    pluginName: string
    pluginDescription: string
    marketplaceName: string
    sourceCommand: string
    onResponse: (r: unknown) => void
  }>
  DesktopUpsellStartup: React.ComponentType<{ onDone: () => void }>
  UltraplanChoiceDialog: React.ComponentType<{
    plan: unknown
    sessionId: string
    taskId: string
    setMessages: (m: unknown) => void
    readFileState: unknown
    getAppState: () => unknown
    setConversationId: (id: string) => void
  }> | null
  UltraplanLaunchDialog: React.ComponentType<{
    onChoice: (choice: string, opts?: { disconnectedBridge?: unknown }) => void
  }> | null
}

type NetworkHostPattern = { host: string; port?: number }

export function renderREPLDialogs(deps: REPLDialogsDeps, slots: REPLDialogsSlots): React.ReactNode {
  const { SandboxPermissionRequest, IdeOnboardingDialog, EffortCallout, RemoteCallout, PluginHintMenu, DesktopUpsellStartup, UltraplanChoiceDialog, UltraplanLaunchDialog } = slots
  return <>
    {deps.focusedInputDialog === 'sandbox-permission' && <SandboxPermissionRequest key={deps.sandboxPermissionRequestQueue[0]!.hostPattern.host} hostPattern={deps.sandboxPermissionRequestQueue[0]!.hostPattern} onUserResponse={(response: { allow: boolean; persistToSettings: boolean }) => {
      const { allow, persistToSettings } = response
      const currentRequest = deps.sandboxPermissionRequestQueue[0]
      if (!currentRequest) return
      const approvedHost = currentRequest.hostPattern.host
      if (persistToSettings) {
        const update = {
          type: 'addRules' as const,
          rules: [{
            toolName: WEB_FETCH_TOOL_NAME,
            ruleContent: `domain:${approvedHost}`,
          }],
          behavior: (allow ? 'allow' : 'deny') as 'allow' | 'deny',
          destination: 'localSettings' as const,
        }
        deps.setAppState((prev: unknown) => ({
          ...(prev as object),
          toolPermissionContext: applyPermissionUpdate((prev as { toolPermissionContext: unknown }).toolPermissionContext as never, update as never),
        }))
        persistPermissionUpdate(update as never)
        // Immediately update sandbox in-memory config to prevent race
        // conditions where pending requests slip through before settings
        // change is detected
        SandboxManager.refreshConfig()
      }
      // Resolve ALL pending requests for the same host (not just the
      // first one) — handles parallel requests for the same domain.
      deps.setSandboxPermissionRequestQueue((queue: unknown[]) => {
        const typed = queue as Array<{ hostPattern: { host: string }; resolvePromise: (allow: boolean) => void }>
        typed.filter(item => item.hostPattern.host === approvedHost).forEach(item => item.resolvePromise(allow))
        return typed.filter(item => item.hostPattern.host !== approvedHost) as unknown[]
      })
      // Clean up bridge subscriptions and cancel remote prompts for this
      // host since the local user already responded.
      const cleanups = deps.sandboxBridgeCleanupRef.current?.get(approvedHost)
      if (cleanups) {
        for (const fn of cleanups) fn()
        deps.sandboxBridgeCleanupRef.current?.delete(approvedHost)
      }
    }} />}
    {deps.focusedInputDialog === 'prompt' && <PromptDialog key={deps.promptQueue[0]!.request.prompt} title={deps.promptQueue[0]!.title} toolInputSummary={deps.promptQueue[0]!.toolInputSummary as never} request={deps.promptQueue[0]!.request as never} onRespond={(selectedKey: unknown) => {
      const item = deps.promptQueue[0]
      if (!item) return
      item.resolve({ prompt_response: item.request.prompt, selected: selectedKey })
      deps.setPromptQueue(([, ...tail]: unknown[]) => tail)
    }} onAbort={() => {
      const item = deps.promptQueue[0]
      if (!item) return
      item.reject(new Error('Prompt cancelled by user'))
      deps.setPromptQueue(([, ...tail]: unknown[]) => tail)
    }} />}
    {/* Show pending indicator on worker while waiting for leader approval */}
    {deps.pendingWorkerRequest && <WorkerPendingPermission toolName={deps.pendingWorkerRequest.toolName} description={deps.pendingWorkerRequest.description} />}
    {/* Show pending indicator for sandbox permission on worker side */}
    {deps.pendingSandboxRequest && <WorkerPendingPermission toolName="Network Access" description={`Waiting for leader to approve network access to ${deps.pendingSandboxRequest.host}`} />}
    {/* Worker sandbox permission requests from swarm workers */}
    {deps.focusedInputDialog === 'worker-sandbox-permission' && <SandboxPermissionRequest key={deps.workerSandboxPermissions.queue[0]!.requestId} hostPattern={{
      host: deps.workerSandboxPermissions.queue[0]!.host,
      port: undefined,
    } as NetworkHostPattern} onUserResponse={(response: { allow: boolean; persistToSettings: boolean }) => {
      const { allow, persistToSettings } = response
      const currentRequest = deps.workerSandboxPermissions.queue[0]
      if (!currentRequest) return
      const approvedHost = currentRequest.host
      // Send response via mailbox to the worker
      void sendSandboxPermissionResponseViaMailbox(currentRequest.workerName, currentRequest.requestId, approvedHost, allow, deps.teamContext?.teamName)
      if (persistToSettings && allow) {
        const update = {
          type: 'addRules' as const,
          rules: [{
            toolName: WEB_FETCH_TOOL_NAME,
            ruleContent: `domain:${approvedHost}`,
          }],
          behavior: 'allow' as const,
          destination: 'localSettings' as const,
        }
        deps.setAppState((prev: unknown) => ({
          ...(prev as object),
          toolPermissionContext: applyPermissionUpdate((prev as { toolPermissionContext: unknown }).toolPermissionContext as never, update as never),
        }))
        persistPermissionUpdate(update as never)
        SandboxManager.refreshConfig()
      }
      // Remove from queue
      deps.setAppState((prev: unknown) => ({
        ...(prev as object),
        workerSandboxPermissions: {
          ...((prev as { workerSandboxPermissions: { queue: unknown[] } }).workerSandboxPermissions),
          queue: (prev as { workerSandboxPermissions: { queue: unknown[] } }).workerSandboxPermissions.queue.slice(1),
        },
      }))
    }} />}
    {deps.focusedInputDialog === 'elicitation' && <ElicitationDialog key={deps.elicitation.queue[0]!.serverName + ':' + String(deps.elicitation.queue[0]!.requestId)} event={deps.elicitation.queue[0]! as never} onResponse={(action: unknown, content: unknown) => {
      const currentRequest = deps.elicitation.queue[0]
      if (!currentRequest) return
      // Call respond callback to resolve Promise
      currentRequest.respond({ action, content })
      // For URL accept, keep in queue for phase 2
      const isUrlAccept = currentRequest.params.mode === 'url' && action === 'accept'
      if (!isUrlAccept) {
        deps.setAppState((prev: unknown) => ({
          ...(prev as object),
          elicitation: { queue: (prev as { elicitation: { queue: unknown[] } }).elicitation.queue.slice(1) },
        }))
      }
    }} onWaitingDismiss={(action: unknown) => {
      const currentRequest = deps.elicitation.queue[0]
      // Remove from queue
      deps.setAppState((prev: unknown) => ({
        ...(prev as object),
        elicitation: { queue: (prev as { elicitation: { queue: unknown[] } }).elicitation.queue.slice(1) },
      }))
      currentRequest?.onWaitingDismiss?.(action)
    }} />}
    {deps.focusedInputDialog === 'cost' && <CostThresholdDialog onDone={() => {
      deps.setShowCostDialog(false)
      deps.setHaveShownCostDialog(true)
      saveGlobalConfig((current: unknown) => ({
        ...(current as object),
        hasAcknowledgedCostThreshold: true,
      }) as never)
      logEvent('tengu_cost_threshold_acknowledged' as never, {})
    }} />}
    {deps.focusedInputDialog === 'idle-return' && deps.idleReturnPending && <IdleReturnDialog idleMinutes={deps.idleReturnPending.idleMinutes} totalInputTokens={deps.getTotalInputTokens()} onDone={async (action: unknown) => {
      const pending = deps.idleReturnPending!
      deps.setIdleReturnPending(null)
      logEvent('tengu_idle_return_action' as never, {
        action: action as never,
        idleMinutes: Math.round(pending.idleMinutes),
        messageCount: deps.messagesRef.current?.length ?? 0,
        totalInputTokens: deps.getTotalInputTokens(),
      })
      if (action === 'dismiss') {
        deps.setInputValue(pending.input)
        return
      }
      if (action === 'never') {
        saveGlobalConfig((current: unknown) => {
          const c = current as { idleReturnDismissed?: boolean }
          if (c.idleReturnDismissed) return current as never
          return { ...c, idleReturnDismissed: true } as never
        })
      }
      if (action === 'clear') {
        const { clearConversation } = await import('src/commands/clear/conversation.js')
        await clearConversation({
          setMessages: deps.setMessages as never,
          readFileState: deps.readFileState.current as never,
          discoveredSkillNames: deps.discoveredSkillNamesRef.current as never,
          loadedNestedMemoryPaths: deps.loadedNestedMemoryPathsRef.current as never,
          getAppState: () => deps.store.getState() as never,
          setAppState: deps.setAppState as never,
          setConversationId: deps.setConversationId,
        })
        if (deps.haikuTitleAttemptedRef.current !== undefined) {
          deps.haikuTitleAttemptedRef.current = false
        }
        deps.setHaikuTitle(undefined)
        deps.bashTools.current?.clear()
        if (deps.bashToolsProcessedIdx.current !== undefined) {
          deps.bashToolsProcessedIdx.current = 0
        }
      }
      if (deps.skipIdleCheckRef.current !== undefined) {
        deps.skipIdleCheckRef.current = true
      }
      void deps.onSubmitRef.current?.(pending.input, {
        setCursorOffset: () => { },
        clearBuffer: () => { },
        resetHistory: () => { },
      })
    }} />}
    {deps.focusedInputDialog === 'ide-onboarding' && <IdeOnboardingDialog onDone={() => deps.setShowIdeOnboarding(false)} installationStatus={deps.ideInstallationStatus} />}
    {deps.focusedInputDialog === 'effort-callout' && <EffortCallout model={deps.mainLoopModel} onDone={(selection: string) => {
      deps.setShowEffortCallout(false)
      if (selection !== 'dismiss') {
        deps.setAppState((prev: unknown) => ({ ...(prev as object), effortValue: selection }))
      }
    }} />}
    {deps.focusedInputDialog === 'remote-callout' && <RemoteCallout onDone={(selection: string) => {
      deps.setAppState((prev: unknown) => {
        const p = prev as { showRemoteCallout?: boolean }
        if (!p.showRemoteCallout) return prev
        return {
          ...p,
          showRemoteCallout: false,
          ...(selection === 'enable' && {
            replBridgeEnabled: true,
            replBridgeExplicit: true,
            replBridgeOutboundOnly: false,
          }),
        }
      })
    }} />}

    {deps.exitFlow}

    {deps.focusedInputDialog === 'plugin-hint' && deps.hintRecommendation && <PluginHintMenu pluginName={deps.hintRecommendation.pluginName} pluginDescription={deps.hintRecommendation.pluginDescription} marketplaceName={deps.hintRecommendation.marketplaceName} sourceCommand={deps.hintRecommendation.sourceCommand} onResponse={deps.handleHintResponse} />}

    {deps.focusedInputDialog === 'desktop-upsell' && <DesktopUpsellStartup onDone={() => deps.setShowDesktopUpsellStartup(false)} />}

    {feature('ULTRAPLAN') && UltraplanChoiceDialog ? deps.focusedInputDialog === 'ultraplan-choice' && deps.ultraplanPendingChoice && <UltraplanChoiceDialog plan={deps.ultraplanPendingChoice.plan} sessionId={deps.ultraplanPendingChoice.sessionId} taskId={deps.ultraplanPendingChoice.taskId} setMessages={deps.setMessages} readFileState={deps.readFileState.current} getAppState={() => deps.store.getState()} setConversationId={deps.setConversationId} /> : null}

    {feature('ULTRAPLAN') && UltraplanLaunchDialog ? deps.focusedInputDialog === 'ultraplan-launch' && deps.ultraplanLaunchPending && <UltraplanLaunchDialog onChoice={(choice: string, opts?: { disconnectedBridge?: unknown }) => {
      const blurb = deps.ultraplanLaunchPending!.blurb
      deps.setAppState((prev: unknown) => {
        const p = prev as { ultraplanLaunchPending?: unknown }
        return p.ultraplanLaunchPending ? { ...p, ultraplanLaunchPending: undefined } : prev
      })
      if (choice === 'cancel') return
      // Command's onDone used display:'skip', so add the echo here —
      // gives immediate feedback before the ~5s teleportToRemote resolves.
      deps.setMessages((prev: unknown) => [...(prev as unknown[]), deps.createCommandInputMessage(deps.formatCommandInputTags('ultraplan', blurb))] as unknown)
      const appendStdout = (msg: string) => deps.setMessages((prev: unknown) => [...(prev as unknown[]), deps.createCommandInputMessage(`<${deps.LOCAL_COMMAND_STDOUT_TAG}>${deps.escapeXml(msg)}</${deps.LOCAL_COMMAND_STDOUT_TAG}>`)] as unknown)
      // Defer the second message if a query is mid-turn so it lands
      // after the assistant reply, not between the user's prompt and
      // the reply.
      const appendWhenIdle = (msg: string) => {
        if (!deps.queryGuard.isActive) {
          appendStdout(msg)
          return
        }
        const unsub = deps.queryGuard.subscribe(() => {
          if (deps.queryGuard.isActive) return
          unsub()
          // Skip if the user stopped ultraplan while we were waiting —
          // avoids a stale "Monitoring <url>" message for a session
          // that's gone.
          if (!(deps.store.getState() as { ultraplanSessionUrl?: string }).ultraplanSessionUrl) return
          appendStdout(msg)
        })
      }
      void deps.launchUltraplan({
        blurb,
        getAppState: () => deps.store.getState(),
        setAppState: deps.setAppState,
        signal: deps.createAbortController().signal,
        disconnectedBridge: opts?.disconnectedBridge,
        onSessionReady: appendWhenIdle,
      }).then(appendStdout).catch(logError)
    }} /> : null}
  </>
}

