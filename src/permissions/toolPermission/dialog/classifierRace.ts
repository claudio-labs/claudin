/**
 * The Bash prompt-rule classifier racing an open dialog. A confident match
 * allows the call unless somebody answered first or the user took the
 * dialog over; the dialog then lingers as a checkmark before it goes.
 */
import { getTerminalFocused } from 'src/terminal/ink/terminal-focus-state.js'
import { executeAsyncClassifierCheck } from 'src/tools/BashTool/bashPermissions.js'
import { clearClassifierChecking, setClassifierApproval, setClassifierChecking } from 'src/permissions/classifierApprovals.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import type { PendingClassifierCheck, PermissionDecisionReason } from 'src/shared/types/permissions.js'
import type { PermissionContext, ResolveOnce } from 'src/permissions/toolPermission/PermissionContext.js'
import { ruleOf } from 'src/permissions/toolPermission/promptRule.js'

/** Keypresses this soon after the dialog opened are taken as typed-ahead, not as a choice. */
const TYPE_AHEAD_GRACE_MS = 200
const CHECKMARK_FOCUSED_MS = 3_000
const CHECKMARK_UNFOCUSED_MS = 1_000

export type ClassifierRaceDeps = {
  ctx: PermissionContext
  pending: PendingClassifierCheck
  once: ResolveOnce<PermissionDecision>
  openedAt: number
  /** Whether an approved dialog lingers as a checkmark; otherwise it goes at once. */
  showsCheckmark: boolean
  /** Called when the classifier wins, before anything else changes. */
  onApproved(): void
}

export type ClassifierRace = {
  /** A keypress in the dialog. */
  userInteracted(): void
  /** Somebody else answered: the classification may no longer allow. */
  stop(): void
  dismissCheckmark(): void
}

export function startClassifierRace(deps: ClassifierRaceDeps): ClassifierRace {
  const { ctx, once } = deps
  const signal = ctx.toolUseContext.abortController.signal
  // False once anyone answered or the user took the dialog over.
  let running = true
  let checkmark: ReturnType<typeof setTimeout> | undefined

  const stop = (): void => {
    if (!running) return
    running = false
    clearClassifierChecking(ctx.toolUseID)
    ctx.updateQueueItem({ classifierCheckInProgress: false })
  }

  const removeCheckmark = (): void => {
    if (checkmark === undefined) return
    clearTimeout(checkmark)
    checkmark = undefined
    signal.removeEventListener('abort', removeCheckmark)
    ctx.removeFromQueue()
  }

  const showCheckmark = (rule: string): void => {
    if (!deps.showsCheckmark) {
      ctx.removeFromQueue()
      return
    }
    ctx.updateQueueItem({ classifierCheckInProgress: false, classifierAutoApproved: true, classifierMatchedRule: rule })
    checkmark = setTimeout(removeCheckmark, getTerminalFocused() ? CHECKMARK_FOCUSED_MS : CHECKMARK_UNFOCUSED_MS)
    signal.addEventListener('abort', removeCheckmark, { once: true })
  }

  const approve = (reason: PermissionDecisionReason): void => {
    const rule = ruleOf(reason)
    if (rule === undefined || !once.claim()) {
      stop()
      return
    }
    running = false
    deps.onApproved()
    clearClassifierChecking(ctx.toolUseID)
    showCheckmark(rule)
    setClassifierApproval(ctx.toolUseID, rule)
    ctx.logDecision({ decision: 'accept', source: { type: 'classifier' } })
    // The classifier judged the command as made, so that is what runs.
    once.resolve(ctx.buildAllow(ctx.input, { decisionReason: reason }))
  }

  setClassifierChecking(ctx.toolUseID)
  executeAsyncClassifierCheck(deps.pending, signal, ctx.toolUseContext.options.isNonInteractiveSession, {
    shouldContinue: () => running,
    onAllow: approve,
    onComplete: stop,
  }).catch((error: unknown) => {
    stop()
    if (signal.aborted) {
      logForDebugging(`Bash prompt-rule classifier ended with the turn: ${errorMessage(error)}`)
      return
    }
    logError(toError(error))
  })

  return {
    userInteracted() {
      if (!running || Date.now() - deps.openedAt <= TYPE_AHEAD_GRACE_MS) return
      stop()
    },
    stop,
    dismissCheckmark: removeCheckmark,
  }
}
