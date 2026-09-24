/**
 * Hooks for a call that stands for several calls of its tool (Tool.hookUnits
 * — the batch Read, one unit per file and symbol). To a hook such a call IS
 * its units: every hook runs once per unit, with the input that unit's call
 * would carry, and never with the call's own input, which no hook was written
 * against. The dispatch lives with the single-call dispatch it loops over —
 * toolHooks.ts (PreToolUse, PostToolUse, PostToolUseFailure) and replHooks.ts
 * (PermissionRequest, PermissionDenied). This module is the pure half: how
 * the units' verdicts fold into the one verdict the call gets, the way
 * checkBatchReadPermission folds the permission rules.
 *
 * - Any unit denied → the call is denied, and the message names each denied
 *   unit with its hook's reason.
 * - Else any unit asks → ONE ask, naming the units that asked.
 * - Else every unit allowed → the call is allowed.
 * - Else no verdict: the call takes the ordinary permission check, which
 *   judges every unit — at least as strict as the units taken one by one.
 */
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionRequestResult } from 'src/shared/types/hooks.js'
import type { PermissionUpdate } from 'src/shared/types/permissions.js'
import { findToolByName, type HookUnits, type Tools } from 'src/tools/Tool.js'

/**
 * Unit calls whose hooks run at once — the default cap on concurrent tool
 * calls (toolOrchestration.ts), which is what the same units sent as separate
 * calls would get.
 */
export const UNIT_HOOK_CONCURRENCY = 10

/** Labels each thing a unit's hooks yield with the unit, so several can run at once. */
export async function* tagUnit<T>(
  unit: number,
  events: AsyncGenerator<T>,
): AsyncGenerator<{ unit: number; event: T }, void> {
  for await (const event of events) yield { unit, event }
}

/**
 * The units a call stands for, for the dispatchers that get a tool's name and
 * input rather than the tool (replHooks.ts). Undefined for an ordinary call.
 */
export function hookUnitsFor(
  tools: Tools | undefined,
  toolName: string,
  toolInput: unknown,
): HookUnits | undefined {
  if (!tools || typeof toolInput !== 'object' || toolInput === null) return undefined
  return findToolByName(tools, toolName)?.hookUnits?.(
    toolInput as Record<string, unknown>,
  )
}

type UnitPreToolVerdict = {
  /** The call's input with the units' updatedInput folded in, when a hook changed one. */
  updatedInput?: Record<string, unknown>
  /** The one permission verdict the call gets, when the units' hooks gave one. */
  permission?: PermissionResult
}

/**
 * The call's PreToolUse verdict from its units'. `decisions[i]` is the last
 * permission result unit i's hooks produced — what the single-call loop in
 * toolExecution.ts keeps — and `passthrough[i]` the updatedInput a hook gave
 * it without deciding. A unit's updated input is its allow/ask decision's, or
 * failing that the passthrough one: the precedence resolveHookPermissionDecision
 * applies to a single call.
 */
export function foldPreToolUseUnits(
  units: HookUnits,
  decisions: readonly (PermissionResult | undefined)[],
  passthrough: readonly (Record<string, unknown> | undefined)[],
  hookName: string,
): UnitPreToolVerdict {
  const denied = unitsWhere(units, decisions, d => d.behavior === 'deny')
  if (denied.length > 0) {
    return {
      permission: hookDeny(
        hookName,
        denialMessage(hookName, units, denied.map(i => [i, messageOf(decisions[i])])),
      ),
    }
  }

  const updated = units.inputs.map((_, i) => {
    const decision = decisions[i]
    return (decision?.behavior === 'allow' || decision?.behavior === 'ask') &&
      decision.updatedInput !== undefined
      ? decision.updatedInput
      : passthrough[i]
  })
  let updatedInput: Record<string, unknown> | undefined
  if (updated.some(input => input !== undefined)) {
    const merged = units.merge(updated)
    if ('refusal' in merged) return { permission: hookDeny(hookName, merged.refusal) }
    updatedInput = merged.input
  }

  const asked = unitsWhere(units, decisions, d => d.behavior === 'ask')
  const [firstAsked] = asked
  if (firstAsked !== undefined) {
    const message = [
      `${hookName} hook asks before ${asked.length === units.inputs.length ? 'every part' : 'part'} of this call:`,
      ...uniqueLines(asked.map(i => `- ${units.label(i)}: ${messageOf(decisions[i])}`)),
    ].join('\n')
    const reason = decisions[firstAsked]?.decisionReason
    return {
      ...(updatedInput && { updatedInput }),
      permission: {
        behavior: 'ask',
        message,
        decisionReason: {
          type: 'hook',
          hookName,
          ...(reason?.type === 'hook' && reason.hookSource !== undefined && {
            hookSource: reason.hookSource,
          }),
          reason: message,
        },
      },
    }
  }

  const allowed = unitsWhere(units, decisions, d => d.behavior === 'allow')
  const first = decisions[0]
  if (allowed.length === units.inputs.length && first?.behavior === 'allow') {
    return {
      ...(updatedInput && { updatedInput }),
      permission: { behavior: 'allow', decisionReason: first.decisionReason },
    }
  }
  return updatedInput ? { updatedInput } : {}
}

/**
 * The call's PermissionRequest decision from its units'. `decisions[i]` is
 * the first allow or deny unit i's hooks gave — the one each consumer of a
 * single call's PermissionRequest hooks acts on (PermissionContext.ts,
 * requestMessage.ts, structuredIO.ts). Undefined leaves the call to the
 * prompt, or to the headless fallback.
 */
export function foldPermissionRequestUnits(
  units: HookUnits,
  decisions: readonly (PermissionRequestResult | undefined)[],
): PermissionRequestResult | undefined {
  const denied = unitsWhere(units, decisions, d => d.behavior === 'deny')
  if (denied.length > 0) {
    const interrupt = denied.some(i => {
      const decision = decisions[i]
      return decision?.behavior === 'deny' && decision.interrupt === true
    })
    return {
      behavior: 'deny',
      message: denialMessage(
        'PermissionRequest',
        units,
        denied.map(i => {
          const decision = decisions[i]
          return [
            i,
            (decision?.behavior === 'deny' && decision.message) || 'Permission denied by hook',
          ]
        }),
      ),
      ...(interrupt && { interrupt: true }),
    }
  }

  const allowed = unitsWhere(units, decisions, d => d.behavior === 'allow')
  if (allowed.length !== units.inputs.length) return undefined

  const updated = units.inputs.map((_, i) => {
    const decision = decisions[i]
    return decision?.behavior === 'allow' ? decision.updatedInput : undefined
  })
  let updatedInput: Record<string, unknown> | undefined
  if (updated.some(input => input !== undefined)) {
    const merged = units.merge(updated)
    if ('refusal' in merged) return { behavior: 'deny', message: merged.refusal }
    updatedInput = merged.input
  }
  const updatedPermissions = uniqueUpdates(
    decisions.flatMap(d => (d?.behavior === 'allow' ? (d.updatedPermissions ?? []) : [])),
  )
  return {
    behavior: 'allow',
    ...(updatedInput && { updatedInput }),
    ...(updatedPermissions.length > 0 && { updatedPermissions }),
  }
}

function unitsWhere<D>(
  units: HookUnits,
  decisions: readonly (D | undefined)[],
  test: (decision: D) => boolean,
): number[] {
  const matching: number[] = []
  for (let i = 0; i < units.inputs.length; i++) {
    const decision = decisions[i]
    if (decision !== undefined && test(decision)) matching.push(i)
  }
  return matching
}

function messageOf(decision: PermissionResult | undefined): string {
  return decision && 'message' in decision && decision.message ? decision.message : ''
}

function hookDeny(hookName: string, message: string): PermissionResult {
  return {
    behavior: 'deny',
    message,
    decisionReason: { type: 'hook', hookName, reason: message },
  }
}

function denialMessage(
  hookName: string,
  units: HookUnits,
  denied: readonly (readonly [number, string])[],
): string {
  const head =
    denied.length === units.inputs.length
      ? `${hookName} hook denied every part of this call:`
      : `${hookName} hook denied part of this call, so none of it ran — leave these out to run the rest:`
  return [head, ...uniqueLines(denied.map(([i, message]) => `- ${units.label(i)}: ${message}`))].join(
    '\n',
  )
}

function uniqueLines(lines: readonly string[]): string[] {
  return [...new Set(lines)]
}

/** Several units' hooks may return the same "always allow" rule; persist it once. */
function uniqueUpdates(updates: readonly PermissionUpdate[]): PermissionUpdate[] {
  const seen = new Set<string>()
  return updates.filter(update => {
    const key = JSON.stringify(update)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
