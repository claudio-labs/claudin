/**
 * `then` on Patch and Edit (`CLAUDIN_EDIT_THEN=1`): the commands that check an
 * edit run right after it applies, in the same tool call. The flag, the schema
 * field and the result shape live in `editThenShape.ts`.
 *
 * Every step runs where the tool's own step runs, so nothing new sits between
 * the model and the permission system:
 *
 * - `resolveThen` (the tool's resolveInput, with the session's real mode)
 *   drops `then` wherever running it would skip something the user relies on:
 *   a PreToolUse or PostToolUse hook, which would not see these commands; a
 *   permission rule that denies one; or a command that would need a prompt.
 *   The Patch and Edit dialogs show the edit, not the commands, so a prompt is
 *   only acceptable where none opens — bypass and auto. The edit still
 *   applies, and its result says why the commands did not run.
 * - `foldThenPermission` (checkPermissions) joins each command's Bash verdict
 *   to the edit's, the way GitTool does (`GitTool/permissions.ts`): deny wins,
 *   a command that asks makes the call ask, and the tool's OWN input is echoed
 *   on every decision, never Bash's `{ command }` (team memory
 *   `checkbatchwrite-updatedinput-clobbers-input`). In auto mode the ask
 *   reaches the classifier, which reads `thenClassifierInput`.
 * - `runThen` (call) runs them through BashTool's own call — output filter,
 *   sandbox, cwd and timeout as a Bash call would have them — in order, and
 *   stops at the first that fails.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import type { PermissionDecision, PermissionResult } from 'src/shared/types/permissions.js'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import { hasHookForEvent } from 'src/platform/lifecycleHooks/matching.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { errorMessage, ShellError } from 'src/shared/errors.js'
import { thenCommands, type ThenRun } from 'src/tools/shared/editThen/editThenShape.js'

type ThenInput = { then?: readonly string[] | null }

export type EditThenDeps = {
  permissionFor(command: string, context: ToolUseContext): Promise<PermissionResult>
  hooksConfigured(context: ToolUseContext): boolean
  runCommand(
    command: string,
    context: ToolUseContext,
  ): Promise<{ exitCode: number | null; output: string }>
}

/* eslint-disable @typescript-eslint/no-require-imports */
// Lazy, like tools.ts: BashTool's import chain reaches the tool registry,
// which imports the edit tools that import this module.
const getBashTool = () =>
  (require('src/tools/BashTool/BashTool.js') as typeof import('src/tools/BashTool/BashTool.js'))
    .BashTool
/* eslint-enable @typescript-eslint/no-require-imports */

function blockText(block: ToolResultBlockParam): string {
  if (typeof block.content === 'string') return block.content
  return (block.content ?? []).map(part => (part.type === 'text' ? part.text : '')).join('\n')
}

async function runWithBash(
  command: string,
  context: ToolUseContext,
): Promise<{ exitCode: number | null; output: string }> {
  const bash = getBashTool()
  try {
    const { data } = await bash.call({ command } as Parameters<typeof bash.call>[0], context)
    const output = blockText(bash.mapToolResultToToolResultBlockParam(data, context.toolUseId ?? 'then'))
    if (data.interrupted || data.backgroundTaskId !== undefined) return { exitCode: null, output }
    // A stripped `| tail -N` reports 0 whatever the base did; the base's own
    // code is the one that says whether the check passed.
    return { exitCode: data.reducedExitCode ?? 0, output }
  } catch (e) {
    if (e instanceof ShellError) {
      const output = [e.stdout, e.stderr].filter(part => part.trim() !== '').join('\n')
      return { exitCode: e.interrupted ? null : e.code, output }
    }
    return { exitCode: null, output: errorMessage(e) }
  }
}

const DEFAULT_EDIT_THEN_DEPS: EditThenDeps = {
  permissionFor: (command, context) => bashToolHasPermission({ command }, context),
  hooksConfigured(context) {
    const appState = context.getAppState()
    const sessionId = context.agentId ?? getSessionId()
    return (
      hasHookForEvent('PreToolUse', appState, sessionId) ||
      hasHookForEvent('PostToolUse', appState, sessionId)
    )
  },
  runCommand: runWithBash,
}

/** An ask even bypass and auto mode turn into a prompt (permissions.ts, steps 1f and 1g). */
function promptsInAnyMode(decision: PermissionResult): boolean {
  const reason = decision.decisionReason
  if (reason?.type === 'safetyCheck') return true
  return reason?.type === 'rule' && reason.rule.ruleBehavior === 'ask'
}

/** Why `then` must not run in this context, or null when it may. */
export async function thenSkipReason(
  commands: readonly string[],
  context: ToolUseContext,
  deps: EditThenDeps = DEFAULT_EDIT_THEN_DEPS,
): Promise<string | null> {
  if (deps.hooksConfigured(context)) {
    return 'a PreToolUse or PostToolUse hook is configured, and it would not see them'
  }
  const permission = context.getAppState().toolPermissionContext
  const unattended =
    permission.mode === 'bypassPermissions' ||
    permission.mode === 'auto' ||
    (permission.mode === 'plan' && permission.isBypassPermissionsModeAvailable === true)
  for (const command of commands) {
    const decision = await deps.permissionFor(command, context)
    if (decision.behavior === 'allow') continue
    if (decision.behavior === 'deny') return `\`${command}\` is denied by a permission rule`
    if (!unattended || promptsInAnyMode(decision)) {
      return `\`${command}\` would need a permission prompt`
    }
  }
  return null
}

/**
 * Why the last resolved edit's `then` was dropped, per agent context. Patch
 * and Edit are not concurrency-safe, so between one's resolveInput and its
 * call no other edit resolves; every resolveInput overwrites the slot, so a
 * note left by a call that failed validation never reaches the next one.
 */
const skipNotes = new WeakMap<FileStateCache, string>()

/** The input with `then` normalized, or dropped — the note for call() kept aside. */
export async function resolveThen<T extends object>(
  input: T,
  context: ToolUseContext,
  deps: EditThenDeps = DEFAULT_EDIT_THEN_DEPS,
): Promise<T> {
  skipNotes.delete(context.readFileState)
  if (!('then' in input)) return input
  const { then: _dropped, ...rest } = input as T & ThenInput
  const commands = thenCommands(input as ThenInput)
  if (commands.length === 0) return rest as T
  const reason = await thenSkipReason(commands, context, deps)
  if (reason === null) return { ...input, then: commands }
  skipNotes.set(context.readFileState, reason)
  return rest as T
}

/** The reason resolveThen dropped this call's `then`, once. */
export function takeThenSkipNote(context: ToolUseContext): string | undefined {
  const note = skipNotes.get(context.readFileState)
  skipNotes.delete(context.readFileState)
  return note
}

/** The edit's permission decision with its `then` commands folded in. */
export async function foldThenPermission<I extends Record<string, unknown>>(
  input: I,
  editDecision: PermissionDecision,
  context: ToolUseContext,
  deps: EditThenDeps = DEFAULT_EDIT_THEN_DEPS,
): Promise<PermissionDecision> {
  const commands = thenCommands(input as ThenInput)
  if (commands.length === 0 || editDecision.behavior === 'deny') return editDecision
  const decisions = await Promise.all(commands.map(command => deps.permissionFor(command, context)))
  const denied = decisions.find(decision => decision.behavior === 'deny')
  if (denied?.behavior === 'deny') return denied
  if (editDecision.behavior === 'ask') return { ...editDecision, updatedInput: input }
  const needsUser = decisions.find(decision => decision.behavior !== 'allow')
  if (needsUser) {
    return {
      behavior: 'ask',
      message: needsUser.message ?? 'The commands in `then` need permission.',
      ...(needsUser.decisionReason && { decisionReason: needsUser.decisionReason }),
      ...('suggestions' in needsUser && needsUser.suggestions && { suggestions: needsUser.suggestions }),
      updatedInput: input,
    }
  }
  return { ...editDecision, updatedInput: input }
}

/** What the auto-mode classifier judges: the edit, then each command. */
export function thenClassifierInput(base: string, input: object): string {
  const commands = thenCommands(input as ThenInput)
  if (commands.length === 0) return base
  return `${base}\n\nthen, in order:\n${commands.map(command => `$ ${command}`).join('\n')}`
}

/** Runs the commands in order; the first that fails leaves the rest unrun. */
export async function runThen(
  commands: readonly string[],
  context: ToolUseContext,
  deps: EditThenDeps = DEFAULT_EDIT_THEN_DEPS,
): Promise<ThenRun[]> {
  const runs: ThenRun[] = []
  let failed = false
  for (const command of commands) {
    if (failed) {
      runs.push({ command, ran: false, exitCode: null, output: '' })
      continue
    }
    const { exitCode, output } = await deps.runCommand(command, context)
    runs.push({ command, ran: true, exitCode, output })
    if (exitCode !== 0) failed = true
  }
  return runs
}

/** The model-facing text the edit's own result gains, empty when there is nothing to say. */
export function formatThen(runs: readonly ThenRun[] | undefined, skipNote: string | undefined): string {
  const parts: string[] = []
  for (const run of runs ?? []) {
    if (!run.ran) {
      parts.push(`Not run, an earlier command failed: $ ${run.command}`)
      continue
    }
    const status =
      run.exitCode === 0
        ? ''
        : run.exitCode === null
          ? '\n(no exit status: interrupted, or moved to the background)'
          : `\nExit code ${run.exitCode}`
    parts.push(`$ ${run.command}\n${run.output.trim() || '(no output)'}${status}`)
  }
  if (skipNote) {
    parts.push(`\`then\` did not run: ${skipNote}. Run the commands as their own Bash call.`)
  }
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : ''
}
